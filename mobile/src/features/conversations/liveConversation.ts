import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatImages } from "./ConversationImage";
import type { usePhoneConversation } from "./usePhoneConversation";

// The chat's Agents, agent-thread, plan and changed-files screens read the
// live conversation without opening a second socket to the desktop.
//
// The chat screen owns the one subscription (usePhoneConversation) and
// publishes what it holds here, keyed by desktop and conversation; the pushed
// screens read it. A native stack keeps the chat mounted beneath whatever is
// pushed over it, so its socket, its outbox and its clock keep running while
// an agent's thread is open. Each publisher holds its own place: a chat pushed
// twice (a link into a chat already open) serves the newest, and the older
// takes over again when that one is popped. With nothing published (the
// screen reached some other way) a reader gets null and says so.

export type LiveConversation = ReturnType<typeof usePhoneConversation> & {
  deviceId: string;
  /** The chat's pictures, as its transcript fetches them; null when the desktop does not serve them. */
  images: ChatImages | null;
};
export type LiveConversationKey = { deviceId: string; workspaceId: string; agentId: string };

const keyOf = (key: LiveConversationKey) =>
  JSON.stringify([key.deviceId, key.workspaceId, key.agentId]);
// Publishers per key, newest last.
const published = new Map<string, { owner: object; value: LiveConversation }[]>();
const listeners = new Map<string, Set<() => void>>();
const notify = (key: string) => {
  for (const listener of listeners.get(key) ?? []) listener();
};

function publish(key: string, owner: object, value: LiveConversation) {
  const entries = published.get(key) ?? [];
  const mine = entries.find((entry) => entry.owner === owner);
  if (mine?.value === value) return;
  if (mine) mine.value = value;
  else entries.push({ owner, value });
  published.set(key, entries);
  notify(key);
}
function withdraw(key: string, owner: object) {
  const entries = (published.get(key) ?? []).filter((entry) => entry.owner !== owner);
  if (entries.length) published.set(key, entries);
  else published.delete(key);
  notify(key);
}

/** The chat screen's side: keep this conversation's live state readable while mounted. */
export function usePublishConversation(key: LiveConversationKey, value: LiveConversation) {
  const owner = useRef({}).current;
  const id = keyOf(key);
  // Every render: the hook's value is a fresh object whenever anything moved.
  useEffect(() => publish(id, owner, value));
  useEffect(() => () => withdraw(id, owner), [id, owner]);
}

/** A pushed screen's side: the conversation as its chat screen holds it now, or null. */
export function useLiveConversation(key: LiveConversationKey): LiveConversation | null {
  const id = keyOf(key);
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(id);
      };
    },
    () => published.get(id)?.at(-1)?.value ?? null,
  );
}
