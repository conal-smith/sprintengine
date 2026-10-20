import type { ConversationThread } from "../../api/conversationWire";
import type { ChatListRow } from "./conversationListLogic";
import { chatHasUnseenTurn, chatWorkspaceKey } from "./conversationListLogic";

// Settling a chat from the phone, telling the desktop a chat was seen, and
// marking one unread, as rules: when a visit stamp is due, which rows a
// settle in flight hides, where Mark unread is offered, and how a visit clock
// the desktop moved back is read against this phone's own readings.
// Kept free of React Native so the regression suite runs the same rules the
// chat list and the chat run. The calls themselves are
// `api/conversationLifecycle.ts`'s.

/** While a chat is on screen, a visit is stamped at most this often, unless a turn ended unseen. */
export const VISIT_STAMP_INTERVAL_MS = 10_000;
/** Leaving within this long of the last stamp sends no second one: the first already said it. */
export const VISIT_LEAVE_DEDUPE_MS = 1_000;

/**
 * What asked for a stamp.
 *
 * - `open`: the chat came on screen.
 * - `tick`: it is still on screen (the heartbeat, a turn ending, the app
 *   coming back to the front).
 * - `leave`: it is going off screen.
 */
export type VisitTrigger = "open" | "tick" | "leave";

export interface VisitStampInput {
  trigger: VisitTrigger;
  now: number;
  /** When this phone last stamped a visit to the chat, or null when it never has. */
  lastSentAt: number | null;
  /** The desktop's visit clock as last listed (`lastVisitedAt`), or null. */
  visitedAt: number | null;
  /** When the chat's last turn ended, as far as this phone knows, or null when none has. */
  turnEndedAt: number | null;
}

/**
 * Whether a visit stamp should go now.
 *
 * A turn that ended after the last visit anyone stamped is one the desktop
 * still shows as finished and unseen, so it goes at once, whatever asked.
 * Otherwise a chat on screen is stamped at most once every
 * `VISIT_STAMP_INTERVAL_MS`, and once more on leaving unless a stamp went in
 * the last moment. A stamp counts from when it was sent, not answered, so a
 * second trigger while the first is in flight sends nothing.
 */
export function visitStampDue(input: VisitStampInput): boolean {
  const covered = Math.max(input.lastSentAt ?? 0, input.visitedAt ?? 0);
  if (input.turnEndedAt !== null && input.turnEndedAt > covered) return true;
  if (input.lastSentAt === null) return true;
  const since = input.now - input.lastSentAt;
  return input.trigger === "leave" ? since >= VISIT_LEAVE_DEDUPE_MS : since >= VISIT_STAMP_INTERVAL_MS;
}

/**
 * Settles this phone has asked for, by `chatWorkspaceKey`, until the list
 * says the same.
 *
 * - `settling`: sent and not yet answered. The row is hidden at once.
 * - `settled`: the desktop confirmed it at `confirmedAt`. The row stays hidden
 *   until a list read that started after then has landed, which omits it.
 *
 * A failed settle is removed, which brings the row back where it was.
 */
export type PendingSettle = { state: "settling" } | { state: "settled"; confirmedAt: number };
export type PendingSettles = Readonly<Record<string, PendingSettle>>;

export function beginSettle(pending: PendingSettles, key: string): PendingSettles {
  return { ...pending, [key]: { state: "settling" } };
}

export function confirmSettle(pending: PendingSettles, key: string, at: number): PendingSettles {
  if (!pending[key]) return pending;
  return { ...pending, [key]: { state: "settled", confirmedAt: at } };
}

export function failSettle(pending: PendingSettles, key: string): PendingSettles {
  if (!pending[key]) return pending;
  const { [key]: _failed, ...rest } = pending;
  return rest;
}

/**
 * The pending settles once a list read that started at `readStartedAt` has
 * landed. A confirmed settle that read already reflects is done with; one
 * still in flight, or confirmed after the read set out (whose answer may
 * still list the chat), keeps its row hidden.
 */
export function settlesAfterRead(pending: PendingSettles, readStartedAt: number): PendingSettles {
  let next: Record<string, PendingSettle> | null = null;
  for (const [key, entry] of Object.entries(pending)) {
    if (entry.state === "settled" && entry.confirmedAt <= readStartedAt) {
      next ??= { ...pending };
      delete next[key];
    }
  }
  return next ?? pending;
}

/** The rows a list draws: every chat less the ones a settle has hidden. */
export function withoutSettling<T extends Pick<ChatListRow, "deviceId" | "thread">>(
  rows: readonly T[],
  pending: PendingSettles,
): T[] {
  if (!Object.keys(pending).length) return [...rows];
  return rows.filter((row) => !pending[chatWorkspaceKey(row)]);
}

/**
 * A Mark unread, as this phone knows of it: the visit clock it moved the chat
 * back to, and when it was made.
 *
 * The desktop's visit clock (`lastVisitedAt`) only moves forward, except by
 * `conversation.mark_unread`, which moves it back to just before the chat's
 * latest finish. Every reading of the chat taken before the mark (this
 * phone's opening of it, a visit answer it holds, a thread it was handed) is
 * then out of date, and the mark wins over it; a reading taken after the mark
 * is the person having read the chat again, and wins over the mark.
 */
export interface VisitRewind {
  /** The visit clock the mark moved the chat back to, on the desktop's clock. */
  visitedAt: number;
  /**
   * When the mark was made: the desktop's `visitRewoundAt` where it lists one;
   * else when this phone's own mark was answered, or when the list read that
   * first showed the clock gone back set out, on the phone's clock. Machines on
   * one tailnet keep time to well under a second of each other, far inside the
   * gap between marking a chat and opening it again.
   */
  rewoundAt: number;
}

/**
 * The Mark unread a listed chat shows, or null for none.
 *
 * A desktop that lists `visitRewoundAt` says so outright. One that does not
 * (as of 2026-10-07 none does) shows it only as its visit clock gone back
 * from the last this phone heard of it (its previous read of the list, or a
 * visit answered before this read set out), which on a desktop that
 * advertises `chat-mark-unread` nothing else does; on any other desktop the
 * clock is read as only ever moving forward, as it always was. A clock the
 * phone has not listed before says nothing either way, so a chat marked
 * unread on the desktop while the app was closed still reads as the phone last
 * saw it until the list says otherwise: read, never anything wrong.
 */
export function listedVisitRewind(input: {
  thread: Pick<ConversationThread, "lastVisitedAt" | "visitRewoundAt">;
  /** The chat's visit clock as this phone last heard it from the desktop, or null. */
  previousVisitedAt: number | null;
  /** When the read that listed `thread` set out, on the phone's clock. */
  readStartedAt: number;
  /** Whether the chat's desktop advertises `chat-mark-unread`. */
  markUnread: boolean;
}): VisitRewind | null {
  const { lastVisitedAt, visitRewoundAt } = input.thread;
  if (lastVisitedAt === undefined) return null;
  if (visitRewoundAt !== undefined) return { visitedAt: lastVisitedAt, rewoundAt: visitRewoundAt };
  if (!input.markUnread || input.previousVisitedAt === null || lastVisitedAt >= input.previousVisitedAt) return null;
  return { visitedAt: lastVisitedAt, rewoundAt: input.readStartedAt };
}

/**
 * Whether a Mark unread resets a reading this phone holds of the chat (when
 * it opened it, or a visit clock it was answered with) to the desktop's
 * rewound clock: the reading is later than that clock, so it would hide the
 * mark, and it was taken before the mark was made (or in the same
 * millisecond, which `chatSeenAt` reads as before it too). A reading taken
 * after the mark stands, and one already at or before the rewound clock has nothing to
 * hide.
 */
export function visitRewindApplies(rewind: VisitRewind, reading: number | null | undefined): boolean {
  return typeof reading === "number" && reading > rewind.visitedAt && reading <= rewind.rewoundAt;
}

/**
 * A listed chat with a Mark unread this phone knows of folded in: a visit
 * clock read before the mark (a list read that set out before this phone's
 * own mark landed) shows the mark's clock instead, and the thread carries the
 * mark's time, so the list's green (`chatSeenAt`) and the "New" divider
 * (`chatOpenedSince`) weigh this phone's readings against it. A clock from a
 * visit after the mark is kept.
 */
export function withVisitRewind<T extends Pick<ConversationThread, "lastVisitedAt" | "visitRewoundAt">>(
  thread: T,
  rewind: VisitRewind | null | undefined,
): T {
  if (!rewind) return thread;
  const listed = thread.lastVisitedAt;
  const lastVisitedAt = listed === undefined || visitRewindApplies(rewind, listed) ? rewind.visitedAt : listed;
  const visitRewoundAt = Math.max(thread.visitRewoundAt ?? rewind.rewoundAt, rewind.rewoundAt);
  if (lastVisitedAt === listed && visitRewoundAt === thread.visitRewoundAt) return thread;
  return { ...thread, lastVisitedAt, visitRewoundAt };
}

/**
 * Whether a chat's row (its long press, the screen reader's actions) and its
 * More menu offer Mark unread: on a desktop that takes it, for a pairing that
 * operates its chats (`ChatListRow.canMarkUnread`), and only once its agent
 * has finished something (`lastTurnEndedAt`), since the desktop refuses a
 * chat with nothing finished. A chat already showing a finish nobody has seen
 * is unread as it is, so it is not offered there, as the desktop's row menu
 * does not.
 */
export function markUnreadOffered(
  row: Pick<ChatListRow, "canMarkUnread" | "lifecycle" | "thread">,
  input: { now: number; openedAt?: number | null },
): boolean {
  if (!row.canMarkUnread || row.thread.lastTurnEndedAt === undefined) return false;
  return !chatHasUnseenTurn(row.thread, { now: input.now, openedAt: input.openedAt, lifecycle: row.lifecycle });
}
