// Notices are DERIVED, not stored. Everything on the bell is a view over what the phone already holds —
// the merged chat list — so there is no notification store to keep in sync,
// expire or migrate, and nothing to go stale behind a screen that is not open.
//
// No react-native import, so `node --test` can pin every rule here.

import type { ConversationThread } from "../../api/conversationWire";
import {
  CHAT_EARLIER_AFTER_MS,
  chatOpenedKey,
  chatRowState,
  chatRowTitle,
  chatTurnEndedAt,
  type ChatListRow,
} from "../conversations/conversationListLogic";

/**
 * Which half of the bell a notice belongs to.
 *
 * `needs-you` is anything stopped waiting for a person. `can-wait` is anything
 * that happened and is worth knowing about. The split is the screen's one
 * control, and it is a split by *who has to act*, not by severity.
 */
export type NoticeLane = "needs-you" | "can-wait";

export type NoticeKind = "chat-waiting" | "chat-finished";

export interface Notice {
  /**
   * Stable across reads, because the read set is stored against it: a notice
   * whose id changed every refresh would be unread forever.
   */
  id: string;
  lane: NoticeLane;
  kind: NoticeKind;
  title: string;
  /** The one muted line under the title. */
  message: string | null;
  /** The project the notice belongs to, as the row's chip. */
  context: string | null;
  /** When it happened, for the row's age. */
  at: number;
  /** Where opening it lands: the chat itself. */
  target: { deviceId: string; thread: ConversationThread };
}

export interface NoticeBuildInput {
  chats: readonly ChatListRow[];
  /** When this phone last opened each chat, by `chatOpenedKey`; a turn seen is not a turn to report. */
  openedAt: Record<string, number>;
  now: number;
}

/**
 * Every notice the phone can derive, newest first inside each lane.
 *
 * The row state is the chat list's own (`chatRowState`), so the bell and the
 * list can never disagree: a chat waiting on an approval or an answer is a
 * needs-you notice, and one that finished a turn nobody has seen since —
 * on this phone or, where the desktop lists its visits, anywhere — within the
 * last day is a can-wait one. A chat has one state at a time, so it never
 * produces both.
 *
 * The day holds here even for a chat the person marked unread, which the list
 * tints at any age: the bell says what happened lately, and a mark is a note
 * the person left on the list for themselves, not news. Ringing it would put a
 * turn that ended last week at the top of what just happened.
 */
export function buildNotices(input: NoticeBuildInput): Notice[] {
  const notices: Notice[] = [];

  for (const row of input.chats) {
    const { thread } = row;
    const openedAt = input.openedAt[chatOpenedKey(row.deviceId, thread.agentId)] ?? null;
    const state = chatRowState(thread, { now: input.now, openedAt, lifecycle: row.lifecycle });
    const { title, agent } = chatRowTitle(row);
    // Two chats in one workspace share a title, so the chip names the agent
    // as well as the project — it is the only thing that tells them apart.
    const context = [agent, row.projectName].filter(Boolean).join(" · ") || null;
    const target = { deviceId: row.deviceId, thread };
    const key = `${row.deviceId}:${thread.agentId}`;
    if (state === "needs-input") {
      notices.push({
        id: `chat-waiting:${key}`,
        lane: "needs-you",
        kind: "chat-waiting",
        title: thread.phase === "waiting_for_approval" ? `${title} needs approval` : `${title} asked a question`,
        message: null,
        context,
        at: thread.updatedAt,
        target,
      });
      continue;
    }
    // A finished chat always has a turn end; the fallback only satisfies the type.
    const ended = chatTurnEndedAt(thread, row.lifecycle) ?? thread.updatedAt;
    if (state === "finished" && input.now - ended < CHAT_EARLIER_AFTER_MS) {
      notices.push({
        // The turn's end is part of the id: a second turn finishing on the
        // same chat is a second notice, and marking the first read must not
        // silence it. The end and not `updatedAt`, which a rename or a usage
        // report moves too, and which would mint a fresh unread notice for
        // the same turn.
        id: `chat-finished:${key}:${ended}`,
        lane: "can-wait",
        kind: "chat-finished",
        title: `${title} finished`,
        message: null,
        context,
        at: ended,
        target,
      });
    }
  }

  return notices.sort((a, b) => b.at - a.at);
}

export interface NoticeLanes {
  needsYou: Notice[];
  canWait: Notice[];
  /** Can-wait notices this phone has not marked read; drives the bell's dot. */
  unreadCanWait: Notice[];
}

/**
 * The two lanes, and which can-wait rows are unread.
 *
 * Read state is the ONE thing persisted, and only for the
 * can-wait lane: a needs-you notice is resolved by the thing itself no longer
 * waiting, which the phone can see, so storing "I read it" there would let a
 * row be dismissed while the agent is still stopped.
 */
export function splitNotices(notices: readonly Notice[], readIds: readonly string[]): NoticeLanes {
  const read = new Set(readIds);
  const needsYou = notices.filter((notice) => notice.lane === "needs-you");
  const canWait = notices.filter((notice) => notice.lane === "can-wait");
  return { needsYou, canWait, unreadCanWait: canWait.filter((notice) => !read.has(notice.id)) };
}

/**
 * The bell's dot: anything waiting, or anything unread that can wait.
 *
 * The dot is not the count. The count is on the screen's two segments, because
 * a number on a bell is a number nobody can act on.
 */
export function bellCount(lanes: NoticeLanes): number {
  return lanes.needsYou.length + lanes.unreadCanWait.length;
}

/**
 * The read set, pruned to notices that still exist.
 *
 * Without this the set grows forever and a recycled id would arrive already
 * read. Pruning against the live notices is exact: a notice that is gone can
 * never come back under the same id, because every finished notice's id
 * carries the instant it was derived from.
 */
export function pruneReadIds(readIds: readonly string[], notices: readonly Notice[]): string[] {
  const live = new Set(notices.map((notice) => notice.id));
  return readIds.filter((id) => live.has(id));
}
