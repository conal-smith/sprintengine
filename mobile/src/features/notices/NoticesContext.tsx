import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { DeviceNotesStore } from "../../storage/sessionStore";
import { pruneReadIds, type Notice } from "./noticesLogic";

export interface NoticesValue {
  /** Can-wait notices this phone has marked read. The only persisted state. */
  readIds: string[];
  markAllRead: (ids: string[]) => void;
  /** Drops read ids whose notices no longer exist, so the set cannot grow forever. */
  prune: (notices: readonly Notice[]) => void;
}

const NoticesContext = createContext<NoticesValue | null>(null);

/**
 * The only state notices keep: what has been read.
 *
 * There is no push switch. One stood here, and on the bell's card, but
 * nothing ever delivered a push once registration left with the relay, so it
 * promised something the phone could not do.
 *
 * Everything else on the bell is derived per render from the chat list, which
 * is why this holds one small value rather than a store of notifications. A
 * store would have to be reconciled against the list on every read, and it
 * would be wrong in exactly the case that matters: a chat that stopped waiting
 * while the phone was asleep.
 *
 * Read state is per phone and never sent anywhere. "I have seen this" is a fact
 * about this device; syncing it would let one phone clear another's rows.
 */
export function NoticesProvider({ store, children }: { store: DeviceNotesStore | null; children: ReactNode }) {
  const [readIds, setReadIds] = useState<string[]>([]);

  useEffect(() => {
    if (!store) return;
    let live = true;
    void store.getReadNoticeIds().then((ids) => {
      if (live) setReadIds(ids);
    });
    // What the push switch stored is cleared; nothing reads it.
    void store.forgetRetiredNotes().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [store]);

  const markAllRead = useCallback(
    (ids: string[]) => {
      // State first, storage second: the dot must clear on the tap even where
      // secure storage is unavailable. There it simply does not survive a
      // relaunch, which is better than not clearing at all.
      setReadIds((current) => {
        const next = [...new Set([...current, ...ids])];
        void store?.saveReadNoticeIds(next);
        return next;
      });
    },
    [store],
  );

  const prune = useCallback(
    (notices: readonly Notice[]) => {
      setReadIds((current) => {
        const next = pruneReadIds(current, notices);
        if (next.length === current.length) return current;
        void store?.saveReadNoticeIds(next);
        return next;
      });
    },
    [store],
  );

  const value = useMemo<NoticesValue>(
    () => ({
      readIds,
      markAllRead,
      prune,
    }),
    [markAllRead, prune, readIds],
  );

  return <NoticesContext.Provider value={value}>{children}</NoticesContext.Provider>;
}

export function useNotices(): NoticesValue {
  const value = useContext(NoticesContext);
  if (!value) {
    throw new Error("useNotices must be called inside a NoticesProvider.");
  }
  return value;
}
