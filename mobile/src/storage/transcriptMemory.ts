import type { ConversationEvent } from "../api/conversationWire";

/**
 * A chat's transcript as its screen last held it: every event applied and the
 * cursor they were applied up to, in the log generation they came from.
 */
export interface RememberedTranscript {
  events: ConversationEvent[];
  lastSeq: number;
  generation?: string;
}

export interface TranscriptMemoryLimits {
  /** How many chats are kept. */
  maxEntries: number;
  /** Roughly how much transcript is kept, in JSON characters, across them. */
  maxChars: number;
}

/**
 * Enough to step between the handful of chats someone is following without a
 * wait. A chat over `maxChars` on its own is still kept while it is the newest:
 * it is the one on screen.
 */
export const TRANSCRIPT_MEMORY_LIMITS: TranscriptMemoryLimits = { maxEntries: 8, maxChars: 8_000_000 };

/** Each event is measured once: events are never changed once received. */
const eventChars = new WeakMap<ConversationEvent, number>();
function charsOf(events: ConversationEvent[]): number {
  let total = 0;
  for (const event of events) {
    let size = eventChars.get(event);
    if (size === undefined) {
      size = JSON.stringify(event).length + 1;
      eventChars.set(event, size);
    }
    total += size;
  }
  return total;
}

/**
 * The transcripts of recently opened chats, held in memory, newest last.
 *
 * The disk cache (conversationCache.ts) is what survives a relaunch; this is
 * what makes going back to a chat instant within one. It is written with the
 * live state on every frame the chat applies, so it is never behind the disk,
 * and it is not bounded by the disk cache's per-chat limits: a turn too long
 * for the disk to keep whole is still here, so reopening its chat resumes from
 * its cursor instead of reloading the last ten turns.
 *
 * Nothing durable lives here. The outbox of unsent messages is read from disk
 * every time, and a desktop that restarted, forked or rewound the chat answers
 * the remembered cursor with a reset from its new log generation, which
 * replaces what is remembered as it replaces what is on screen.
 */
export function createTranscriptMemory(limits: TranscriptMemoryLimits = TRANSCRIPT_MEMORY_LIMITS) {
  const entries = new Map<string, { value: RememberedTranscript; chars: number }>();
  const trim = () => {
    let total = 0;
    for (const entry of entries.values()) total += entry.chars;
    for (const [key, entry] of entries) {
      if (entries.size <= 1 || (entries.size <= limits.maxEntries && total <= limits.maxChars)) break;
      entries.delete(key);
      total -= entry.chars;
    }
  };
  return {
    /** The transcript last held for `key`, which becomes the most recent; null when none is. */
    recall(key: string): RememberedTranscript | null {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    remember(key: string, value: RememberedTranscript) {
      entries.delete(key);
      entries.set(key, { value, chars: charsOf(value.events) });
      trim();
    },
    forget(key: string) {
      entries.delete(key);
    },
    /**
     * Lets go of every transcript but the newest, the chat on screen, when
     * the system runs short of memory: the others are on disk, and opening
     * one again costs a read instead of the app being killed.
     */
    shed() {
      const newest = [...entries.keys()].at(-1);
      for (const key of entries.keys()) if (key !== newest) entries.delete(key);
    },
    /** For the regression suite: what is held, oldest first. */
    keys(): string[] {
      return [...entries.keys()];
    },
  };
}

export type TranscriptMemory = ReturnType<typeof createTranscriptMemory>;

/** The app's one memory: every chat screen reads and writes it. */
export const conversationTranscripts = createTranscriptMemory();

export const transcriptKey = (deviceId: string, key: { workspaceId: string; agentId: string }) =>
  JSON.stringify([deviceId, key.workspaceId, key.agentId]);
