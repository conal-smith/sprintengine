import { drawnAsReply, rowStreaming, type ConversationRow } from "./conversationLogic";

// "Jump to latest": the way back to the end of a chat the reader has scrolled
// away from, and how many replies finished while they were up there. The
// desktop's pill, its words and its counting (`repliesCompletedAfter` there).

/**
 * How far past the screen the transcript has to run before there is anywhere
 * to jump from: the same 64 points the follow latch counts as "at the end".
 */
export const JUMP_SLACK = 64;

/**
 * Where the reader left the end, as the replies stood then: the last reply
 * that had finished, and the first row loaded, which bounds the count when no
 * reply had finished yet.
 */
export type JumpMark = { reply: string | null; firstRow: string | null };

/** A reply as the jump counts it: the turn it answered in, else its own row. */
function replyKey(row: ConversationRow): string | null {
  if (!drawnAsReply(row) || row.kind !== "message") return null;
  return row.turn || row.id;
}

/** The mark taken as the reader leaves the end of the chat. */
export function jumpMark(rows: readonly ConversationRow[], liveTurn: string | null, turnBusy: boolean): JumpMark {
  let reply: string | null = null;
  for (let index = rows.length - 1; index >= 0; index--) {
    const key = replyKey(rows[index]);
    if (key !== null && !rowStreaming(rows[index], liveTurn, turnBusy)) {
      reply = key;
      break;
    }
  }
  return { reply, firstRow: rows[0]?.id ?? null };
}

/**
 * The replies that finished after the mark, counted back from the end, each
 * turn once however many rows its words take. A page of older history loaded
 * above the mark adds none, and a reply still arriving is not news until it
 * ends. When the mark's reply has left the transcript there is nothing to
 * count from, so nothing is called new rather than everything.
 */
export function newRepliesSince(
  rows: readonly ConversationRow[],
  mark: JumpMark,
  liveTurn: string | null,
  turnBusy: boolean,
): number {
  const counted = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const key = replyKey(row);
    if (key !== null && key === mark.reply) return counted.size;
    if (key !== null && !rowStreaming(row, liveTurn, turnBusy)) counted.add(key);
    // No reply had finished when the reader left: everything below what was
    // loaded then is new, and what loaded above it since is not.
    if (mark.reply === null && row.id === mark.firstRow) return counted.size;
  }
  return 0;
}

/** Whether the transcript runs far enough past the screen to be away from its end. */
export function transcriptScrollable(contentHeight: number, viewportHeight: number): boolean {
  return viewportHeight > 0 && contentHeight - viewportHeight > JUMP_SLACK;
}

/**
 * What the control says, or null while it is not offered: only once the chat
 * has landed, while the reader is away from the end of a transcript long
 * enough to be away from.
 */
export function jumpToLatest(input: {
  away: boolean;
  landed: boolean;
  scrollable: boolean;
  newReplies: number;
}): { label: string; accessibilityLabel: string } | null {
  if (!input.away || !input.landed || !input.scrollable) return null;
  if (input.newReplies <= 0) return { label: "Jump to latest", accessibilityLabel: "Jump to latest" };
  const label = `${input.newReplies} new ${input.newReplies === 1 ? "reply" : "replies"}`;
  return { label, accessibilityLabel: `${label}, jump to latest` };
}
