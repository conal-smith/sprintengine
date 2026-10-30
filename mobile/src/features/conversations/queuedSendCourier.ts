import type { ConversationKey } from "../../api/conversationWire";
import type {
  ConversationApi,
  ConversationStream,
} from "../../api/tailnetConversations";
import type { CachedConversation } from "../../storage/conversationCacheModel";
import { queuedSendStale } from "./queuedSends";

// A message queued behind a running turn outlives its chat's screen. The
// desktop takes no send while a turn runs, so the phone holds a queued one
// until the turn ends; the screen's stream did that, and closed with the
// screen, so a message queued before going to another chat sat in the cache
// until that chat was opened again. Leaving a chat now hands its unsent
// messages here: a stream of its own, with no screen, goes on offering them
// and closes once each has been taken or refused. Opening the chat again
// takes them back first, so only one stream ever offers a chat's messages.
//
// A message handed to a desktop that holds queued messages
// (`conversation-queued-sends`) is the desktop's once it answers, and leaves
// the cache then, so this stream never offers it again: the desktop sends it
// when the turn ends. One still unanswered when the screen closed is offered
// here under its own id, which the desktop holds once however often it is
// offered, and which the stream does not offer again once the chat shows the
// desktop sent it (`heldSendLanded`).
//
// A delivered message leaves the cache. A refused one stays there: the chat's
// screen offers it again when next opened, under the same id, and shows the
// desktop's reason beside it, as it does for a refusal it saw itself.
//
// Every message it carries waited while no screen showed it, so it keeps the
// rule a reopened chat keeps (`queuedSends.ts`): one that waited too long, or
// whose turn ended while the phone was away, is not offered. It is marked so
// in the cache, and the chat's screen draws it as Not sent, with Send now.
// One the desktop turned away busy is offered to it to hold, as the screen's
// stream does, and the cache says so.

export interface QueuedSendCourierDeps {
  load(deviceId: string, key: ConversationKey): Promise<CachedConversation | null>;
  update(
    deviceId: string,
    key: ConversationKey,
    updater: (current: CachedConversation) => CachedConversation,
  ): Promise<CachedConversation>;
  /** Calls back, with how long the app was away, each time it comes back; returns how to stop. */
  watchForeground?(onForeground: (backgroundMs: number) => void): () => void;
  /** The wall clock a waiting message's age is read against. */
  now?: () => number;
}

export interface QueuedSendCourier {
  /** Goes on sending what the chat's cache holds unsent, now its screen has closed. */
  carry(input: {
    deviceId: string;
    key: ConversationKey;
    api: ConversationApi;
    /** The desktop holds queued messages: a handed-over send goes to it as one. */
    queuedSends?: boolean;
    /** It holds their pictures and files too (`conversation-queued-attachments`). */
    queuedAttachments?: boolean;
    /** The desktop answers `hello`, the socket's cheap probe. */
    hello?: boolean;
  }): void;
  /** Stops carrying the chat's messages, because its screen is taking them back. */
  release(deviceId: string, key: ConversationKey): void;
  /** Whether a chat's messages are being carried, for tests. */
  carrying(deviceId: string, key: ConversationKey): boolean;
}

const ENDED_STATES = new Set(["blocked", "revoked", "unavailable"]);

export function createQueuedSendCourier(deps: QueuedSendCourierDeps): QueuedSendCourier {
  const carried = new Map<string, () => void>();
  const chatOf = (deviceId: string, key: ConversationKey) =>
    `${deviceId}\0${key.workspaceId}\0${key.agentId}`;
  return {
    carry({ deviceId, key, api, queuedSends = false, queuedAttachments = false, hello = false }) {
      const chat = chatOf(deviceId, key);
      carried.get(chat)?.();
      let stopped = false;
      let stream: ConversationStream | null = null;
      let unwatch: (() => void) | null = null;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (carried.get(chat) === stop) carried.delete(chat);
        unwatch?.();
        stream?.close();
      };
      carried.set(chat, stop);
      const start = async () => {
        // Read here rather than handed over: a send the screen was still
        // writing when it closed is in the cache by the time this read runs.
        const cached = await deps.load(deviceId, key);
        if (stopped) return;
        const keep = (
          commandId: string,
          update: (item: CachedConversation["pending"][number]) => CachedConversation["pending"][number],
        ) =>
          void deps
            .update(deviceId, key, (current) => ({
              ...current,
              pending: current.pending.map((item) => (item.commandId === commandId ? update(item) : item)),
            }))
            .catch(() => {
              /* Left as it was, the stream that next takes it reads the same rule again. */
            });
        // Too old to go without asking now: never offered, and marked so.
        const at = (deps.now ?? Date.now)();
        const pending: CachedConversation["pending"] = [];
        for (const item of cached?.pending ?? []) {
          if (!queuedSendStale(item, at)) pending.push(item);
          else if (item.stale !== true) keep(item.commandId, (entry) => ({ ...entry, stale: true }));
        }
        const unsettled = new Set(pending.map((item) => item.commandId));
        if (!unsettled.size) return stop();
        const settle = (commandIds: string[], delivered: boolean) => {
          const settled = commandIds.filter((commandId) => unsettled.delete(commandId));
          if (!settled.length) return;
          if (delivered)
            void deps
              .update(deviceId, key, (current) => ({
                ...current,
                pending: current.pending.filter((item) => !settled.includes(item.commandId)),
              }))
              .catch(() => {
                /* Left in the cache, it is offered again under its own id, and the desktop answers a repeat from its receipt. */
              });
          if (!unsettled.size) stop();
        };
        stream = api.open(
          key,
          cached?.lastSeq ?? 0,
          {
            onState(state) {
              // Nothing more can be sent; the messages wait in the cache for the chat's screen.
              if (ENDED_STATES.has(state)) stop();
            },
            onFrame(frame) {
              if (frame.type === "snapshot")
                settle(
                  frame.page.events
                    .filter((event) => event.type === "user_message")
                    .map((event) => event.payload?.commandId)
                    .filter((commandId): commandId is string => typeof commandId === "string"),
                  true,
                );
              else if (frame.type === "event" && frame.event.type === "user_message") {
                const commandId = frame.event.payload?.commandId;
                if (typeof commandId === "string") settle([commandId], true);
              } else if (frame.type === "commandResult") settle([frame.commandId], frame.ok);
            },
            onSendHeld(commandId, command, heldAfter) {
              keep(commandId, (item) => ({ ...item, command, heldAfter }));
            },
            // Its turn ended while the phone was away, or the desktop's own
            // limit refused it: it waits on the person in the cache.
            onSendStale(commandId) {
              keep(commandId, (item) => ({ ...item, stale: true }));
              settle([commandId], false);
            },
          },
          {
            pendingSends: pending,
            queuedSends,
            queuedAttachments,
            hello,
            ...(cached?.generation === undefined ? {} : { generation: cached.generation }),
          },
        );
        unwatch = deps.watchForeground?.((backgroundMs) => stream?.foreground(backgroundMs)) ?? null;
      };
      void start().catch(stop);
    },
    release(deviceId, key) {
      carried.get(chatOf(deviceId, key))?.();
    },
    carrying(deviceId, key) {
      return carried.has(chatOf(deviceId, key));
    },
  };
}
