// What the tray's row says of a message scheduled into a chat, as the
// desktop's (`panels/agentChat/scheduledMessages.tsx`) does: when it goes, or
// that it is going, waiting on a turn, or was refused.

import type { ConversationScheduledMessage } from "../../api/conversationWire";
import { sendTimeWords } from "./sendTime";

/** "Sends Today 3:00 PM", "Sending…", "Sends when this turn ends", "Couldn't send: …". */
export function scheduledMessageStatus(
  message: Pick<ConversationScheduledMessage, "sendAt" | "waitingSince" | "sending" | "failure">,
  now: number,
): string {
  if (message.sending) return "Sending…";
  if (message.failure !== undefined) {
    const reason = message.failure.trim().replace(/\.$/u, "");
    return `Couldn't send: ${reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : "the chat refused it"}.`;
  }
  if (message.waitingSince !== undefined) return "Sends when this turn ends";
  return `Sends ${sendTimeWords(message.sendAt, now)}`;
}
