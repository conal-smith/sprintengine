import type { ConversationQueuedMessage } from "../../api/conversationWire";
import { formatTimestamp } from "../../components/formatTimestamp";

// Where a message queued behind a running turn waits, and what the queued
// bubble over the transcript's foot shows.
//
// A desktop that advertises `conversation-queued-sends` holds a queued
// message itself and sends it when the turn ends, so the phone may sleep,
// close or drop off the tailnet in the meantime. It is then the one that says
// what is waiting: its `queued` frames are the list, whole each time, and the
// phone draws them as they come. Between the phone offering a message and the
// desktop's frame naming it, the message is "handing over" and is drawn from
// the phone's own copy, so the bubble does not blink out. A desktop without
// the capability gets nothing new: the phone holds the message, as it always
// has, and offers it when the turn ends (`queuedSendCourier.ts` once the chat
// is closed).

// A message that waited on the phone while the phone was away is not sent
// without asking once it comes back. Android suspends an app in the
// background, so a message refused busy behind a running turn stopped being
// offered the moment the phone slept, and was offered again, under its id,
// the next time the chat opened: a day later, into a chat whose person had
// long since done that work at the desk, as a new turn they did not ask for.
// The phone now keeps when each message was written (`queuedAt`) and, for
// one it carried across an absence (the chat reopened, the app back from the
// background, the courier), offers it only while it is young and its turn has
// not ended in the meantime. Otherwise it is drawn as Not sent, with Send now
// and Discard. While the phone stays in front it waits as it always did, and
// goes when the turn ends: the person is watching it wait.

/**
 * How long a message carried across an absence may have waited and still go
 * without asking: long enough for a short trip away while a turn finishes,
 * short enough that the person has not moved on.
 */
export const QUEUED_SEND_STALE_MS = 10 * 60_000;

/** A waiting send as the rule reads it: a cached entry, or one a stream carries. */
export type WaitingSend = {
  queuedAt?: number;
  stale?: true;
  command: { confirmedStale?: true; composedAt?: number };
};

/**
 * Whether a send carried across an absence is no longer sent without asking
 * at `now`. One the person confirmed always goes; one already found stale
 * stays so; one cached before the phone kept when it was written (neither
 * `queuedAt` nor the send's `composedAt`) is taken for one written long ago.
 */
export function queuedSendStale(item: WaitingSend, now: number): boolean {
  if (item.command.confirmedStale === true) return false;
  if (item.stale === true) return true;
  const queuedAt = item.queuedAt ?? item.command.composedAt;
  if (queuedAt === undefined) return true;
  return now - queuedAt > QUEUED_SEND_STALE_MS;
}

/**
 * Whether a turn's end, by the desktop's clock, is one the send waited on: it
 * ended after the send was written. A send with no time waited on any.
 */
export function turnEndedSince(item: { queuedAt?: number }, endedAt: number): boolean {
  return item.queuedAt === undefined || endedAt >= item.queuedAt;
}

/** The line under a sent message still on its way. */
export function pendingLine(item: { waiting?: boolean; stale?: boolean; queuedAt?: number }, now: number): string {
  if (item.stale)
    return item.queuedAt === undefined
      ? "Not sent"
      : `Not sent · written ${formatTimestamp(new Date(item.queuedAt).toISOString(), now)}`;
  // Refused busy: a turn is running on the desktop that this phone had not
  // heard of yet, and the message goes when it ends.
  if (item.waiting) return "Waiting for the agent's turn to end";
  return "Pending delivery…";
}

/** A message the phone holds until the turn ends, pictures and all. */
export type PhoneQueuedSend = { commandId: string; text: string; uploads: string[] };
/** A message offered to the desktop to hold, not yet in its list. */
export type HandingSend = { commandId: string; text: string };

export type QueuedBubble =
  | { where: "phone"; key: string; commandId: string; text: string; uploads: string[] }
  | { where: "handing"; key: string; commandId: string; text: string }
  | { where: "desktop"; key: string; queuedId: string; text: string; failure?: string };

/**
 * Whether a message queued now goes to the desktop to hold rather than
 * waiting on the phone.
 *
 * - Only to a desktop that holds messages, and only while a turn runs: with
 *   none running, a send goes straight into the chat, as it always did.
 * - With pictures and files only to a desktop that holds them too
 *   (`conversation-queued-attachments`): it copies them the moment it holds the
 *   message, before their uploads are spent. An older desktop refuses `queue`
 *   beside `uploadIds`, so there a message with pictures waits on the phone, as
 *   before, rather than going without them.
 * - Never behind a message the phone is already holding. The desktop sends
 *   what it holds the moment the turn ends, before the phone has heard the
 *   turn end, so a message queued after one with pictures would overtake it.
 *   Holding it on the phone too keeps the two in the order they were written.
 *
 * Skills never come into it: the phone sends none, and the contract would
 * refuse them beside `queue` too.
 */
export function holdsOnDesktop(input: {
  declared: boolean;
  /** The desktop holds pictures and files with a queued message too. */
  attachments: boolean;
  turnBusy: boolean;
  uploads: number;
  phoneQueued: number;
}): boolean {
  return (
    input.declared &&
    input.turnBusy &&
    (input.uploads === 0 || input.attachments) &&
    input.phoneQueued === 0
  );
}

/**
 * Whether the desktop's list has taken a message the phone handed it: some
 * held message carries its words as whole lines. The desktop trims what it
 * holds and joins a turn's messages a line apiece, so a message is in the join
 * exactly when its trimmed words sit between line breaks there.
 */
export function heldByDesktop(messages: readonly ConversationQueuedMessage[], text: string): boolean {
  const words = text.trim();
  if (!words) return true;
  return messages.some((message) => `\n${message.text}\n`.includes(`\n${words}\n`));
}

/** The messages still handing over once the desktop has said what it holds. */
export function stillHanding(handing: readonly HandingSend[], messages: readonly ConversationQueuedMessage[]): HandingSend[] {
  const next = handing.filter((item) => !heldByDesktop(messages, item.text));
  return next.length === handing.length ? (handing as HandingSend[]) : next;
}

/**
 * The queued bubble's entries, oldest first: what the desktop holds (each its
 * own entry, already a line apiece), then what is on its way to it, then what
 * the phone holds. The phone's go last because they are sent last: the
 * desktop sends its own the moment the turn ends.
 */
export function queuedBubbles(input: {
  desktop: readonly ConversationQueuedMessage[];
  handing: readonly HandingSend[];
  phone: readonly PhoneQueuedSend[];
}): QueuedBubble[] {
  return [
    ...input.desktop.map(
      (message): QueuedBubble => ({
        where: "desktop",
        key: `desktop:${message.id}`,
        queuedId: message.id,
        text: message.text,
        ...(message.failure !== undefined ? { failure: message.failure } : {}),
      }),
    ),
    ...input.handing.map(
      (item): QueuedBubble => ({ where: "handing", key: `handing:${item.commandId}`, commandId: item.commandId, text: item.text }),
    ),
    ...input.phone.map(
      (item): QueuedBubble => ({
        where: "phone",
        key: `phone:${item.commandId}`,
        commandId: item.commandId,
        text: item.text,
        uploads: item.uploads,
      }),
    ),
  ];
}

/** The line under a queued entry: where it waits and when it goes, or why it did not. */
export function queuedLine(bubble: QueuedBubble, live: boolean): string {
  if (bubble.where === "desktop")
    return bubble.failure !== undefined ? `Not sent: ${bubble.failure}` : "Queued on the desktop · sends when this turn ends";
  if (bubble.where === "handing") return live ? "Queuing on the desktop…" : "Queued · goes to the desktop when connected";
  return live ? "Queued · sends when this turn ends" : "Queued · sends when connected";
}

/**
 * What to say when the desktop would not give a held message back. Its own
 * words where it gave them ("That message is already on its way into the
 * chat."), since only it knows whether the message went or was taken back
 * elsewhere.
 */
export function cancelRefusal(message: string | undefined): string {
  return message?.trim() || "That message is already on its way into the chat, so it can't be taken back.";
}
