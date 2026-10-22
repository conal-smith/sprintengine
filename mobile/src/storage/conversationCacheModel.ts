import { parseConversationClientFrame } from "../api/conversation-protocol/index";
import type {
  ConversationCommand,
  ConversationEvent,
} from "../api/conversationWire";

export interface CachedConversation {
  /**
   * The resume cursor: the last sequence whose effects `events` hold, in the
   * log `generation` it came from. Both go back to the desktop on reconnect so
   * it can send only what was missed. Sequences have gaps (merged deltas carry
   * their run's last sequence), so this is a position, not a count.
   */
  lastSeq: number;
  generation?: string;
  events: ConversationEvent[];
  pending: Array<{
    commandId: string;
    command: Extract<ConversationCommand, { kind: "send" }>;
    /**
     * For a send handed to the desktop to hold (`queue`): the phone's cursor
     * when it was queued, which no later offer of it can precede. A stream
     * that takes the send over from the cache (the chat reopened, the courier,
     * a restart) reads the chat after this point for the desktop having sent
     * it already (`heldSendLanded`), rather than offering it a second time.
     */
    heldAfter?: number;
    /**
     * When the person pressed Send (epoch ms, this phone's clock). A send
     * that waited longer than `QUEUED_SEND_STALE_MS`, or whose turn ended
     * while the phone was away, is no longer sent without asking
     * (`queuedSends.ts`). One cached before this was kept has none, and is
     * taken for one that waited too long: nothing says when it was written.
     */
    queuedAt?: number;
    /**
     * The phone stopped offering it: it waits on the person's Send now or
     * Discard, across a restart, and no stream sends it until then.
     */
    stale?: true;
  }>;
}
export const MAX_PENDING_SENDS = 20;
export const MAX_CACHE_CHARS = 1_000_000;
const MAX_EVENTS = 300;
const MAX_THREADS = 20;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function validEvent(value: unknown): value is ConversationEvent {
  return (
    object(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.type === "string" &&
    integer(value.createdAt) &&
    typeof value.sessionId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.agentId === "string" &&
    (value.seq === undefined || integer(value.seq)) &&
    (value.payload === undefined || object(value.payload))
  );
}
function validCache(value: unknown): value is CachedConversation {
  if (
    !object(value) ||
    !integer(value.lastSeq) ||
    (value.generation !== undefined &&
      (typeof value.generation !== "string" ||
        value.generation.length === 0 ||
        value.generation.length > 200)) ||
    !Array.isArray(value.events) ||
    !value.events.every(validEvent) ||
    !Array.isArray(value.pending) ||
    value.pending.length > MAX_PENDING_SENDS
  )
    return false;
  const ids = new Set<string>();
  return value.pending.every((item) => {
    if (!object(item)) return false;
    const frame = parseConversationClientFrame({
      type: "command",
      commandId: item.commandId,
      command: item.command,
    });
    if (
      !frame ||
      frame.type !== "command" ||
      frame.command.kind !== "send" ||
      ids.has(frame.commandId) ||
      (item.heldAfter !== undefined &&
        !(Number.isSafeInteger(item.heldAfter) && Number(item.heldAfter) >= 0)) ||
      (item.queuedAt !== undefined && !integer(item.queuedAt)) ||
      (item.stale !== undefined && item.stale !== true)
    )
      return false;
    ids.add(frame.commandId);
    return true;
  });
}

/** Keep complete recent turns, coalescing adjacent text without changing its meaning. */
export function boundedConversationCache(
  value: CachedConversation,
): CachedConversation {
  if (!validCache(value))
    throw new Error("Invalid conversation cache or pending message.");
  const pending = value.pending;
  const pendingSize = JSON.stringify(pending).length;
  if (pendingSize > MAX_CACHE_CHARS - 1024)
    throw new Error(
      "Pending messages exceed local storage. Reconnect before sending more.",
    );
  const events: ConversationEvent[] = [];
  for (const event of value.events) {
    const previous = events.at(-1);
    if (
      (event.type === "content_delta" || event.type === "reasoning_delta") &&
      previous?.type === event.type &&
      previous.sessionId === event.sessionId &&
      previous.payload?.turnId === event.payload?.turnId &&
      typeof previous.payload?.text === "string" &&
      typeof event.payload?.text === "string"
    ) {
      events[events.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          text: previous.payload.text + event.payload.text,
        },
      };
    } else events.push(event);
  }
  const sizes = events.map((event) => JSON.stringify(event).length + 1);
  let total = sizes.reduce((sum, size) => sum + size, pendingSize + 1024);
  let start = 0;
  while (events.length - start > MAX_EVENTS || total > MAX_CACHE_CHARS) {
    let next = start + 1;
    while (next < events.length && events[next].type !== "user_message") next++;
    // Nothing fits: keep the queue, and drop the cursor with the events so
    // the next subscription asks for a fresh snapshot.
    if (next === events.length) return { lastSeq: 0, events: [], pending };
    while (start < next) total -= sizes[start++];
  }
  const kept = events.slice(start);
  // Trimming only drops the oldest turns, so the cursor still describes the
  // newest event held; older turns page back in from the desktop.
  const newest = kept.reduce((seq, event) => Math.max(seq, event.seq ?? 0), 0);
  return {
    lastSeq: Math.max(value.lastSeq, newest),
    ...(value.generation === undefined ? {} : { generation: value.generation }),
    events: kept,
    pending,
  };
}

export interface ConversationCacheStorage {
  keys(): Promise<string[]>;
  read(key: string): Promise<string | null>;
  write(key: string, text: string): Promise<void>;
  remove(key: string): Promise<void>;
}
type Copy = {
  revision: number;
  savedAt: number;
  slot: number;
  data: CachedConversation;
};
/** Serial transactions and two revisioned copies avoid lost outboxes and timestamp ties. */
export function createConversationCacheStore(
  storage: ConversationCacheStorage,
) {
  let chain: Promise<unknown> = Promise.resolve();
  const transact = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };
  const readCopy = async (stem: string, slot: number): Promise<Copy | null> => {
    // IO failures are unknown data, never evidence that a queued thread is empty.
    const text = await storage.read(`${stem}-${slot}.json`);
    try {
      if (!text || text.length > MAX_CACHE_CHARS) return null;
      const raw: unknown = JSON.parse(text);
      if (!object(raw)) return null;
      const data = object(raw.data) ? raw.data : raw;
      if (!validCache(data)) return null;
      return {
        revision: integer(raw.revision) ? raw.revision : 0,
        savedAt: integer(raw.savedAt) ? raw.savedAt : 0,
        slot,
        data: boundedConversationCache(data),
      };
    } catch {
      return null;
    }
  };
  const read = async (stem: string) =>
    (await Promise.all([readCopy(stem, 0), readCopy(stem, 1)]))
      .filter((copy): copy is Copy => copy !== null)
      .sort((a, b) => b.revision - a.revision || b.savedAt - a.savedAt)[0] ??
    null;
  const write = async (
    stem: string,
    updater: (current: CachedConversation) => CachedConversation,
  ) => {
    const keys = await storage.keys();
    const stems = [
      ...new Set(
        keys
          .filter((key) => /^[a-f0-9]+-[01]\.json$/.test(key))
          .map((key) => key.replace(/-[01]\.json$/, "")),
      ),
    ];
    const current = await read(stem);
    if (stems.includes(stem) && !current)
      throw new Error(
        "Existing conversation cache is unreadable; its queued messages were preserved.",
      );
    const data = boundedConversationCache(
      updater(current?.data ?? { lastSeq: 0, events: [], pending: [] }),
    );
    if (!stems.includes(stem) && stems.length >= MAX_THREADS) {
      const candidates = await Promise.all(
        stems.map(async (key) => ({ key, copy: await read(key) })),
      );
      const evict = candidates
        .filter((entry) => entry.copy && !entry.copy.data.pending.length)
        .sort((a, b) => (a.copy?.savedAt ?? 0) - (b.copy?.savedAt ?? 0))[0];
      if (!evict) {
        if (data.pending.length)
          throw new Error(
            "Local message queue is full. Reconnect before opening another queue.",
          );
        return data; // Reading another thread must never evict an unsent message.
      }
      await storage.remove(`${evict.key}-0.json`);
      await storage.remove(`${evict.key}-1.json`);
    }
    const revision = (current?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision))
      throw new Error("Conversation cache revision limit reached.");
    const text = JSON.stringify({ revision, savedAt: Date.now(), data });
    if (text.length > MAX_CACHE_CHARS)
      throw new Error("Conversation cache exceeds local storage.");
    await storage.write(`${stem}-${current?.slot === 0 ? 1 : 0}.json`, text);
    return data;
  };
  return {
    load: (stem: string) =>
      transact(async () => (await read(stem))?.data ?? null),
    save: (stem: string, value: CachedConversation) =>
      transact(() => write(stem, () => value)),
    update: (
      stem: string,
      updater: (current: CachedConversation) => CachedConversation,
    ) => transact(() => write(stem, updater)),
  };
}
