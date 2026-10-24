import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import {
  createTailnetConversationsApi,
  type ConversationApi,
  type ConversationStream,
  type ConversationConnectionState,
} from "../../api/tailnetConversations";
import {
  conversationSendProblem,
  conversationSessionWasLost,
  LOST_REQUEST_SENTENCE,
  plainLineBreaks,
  type ConversationClientFrame,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationPermissionPreset,
  type ConversationQueuedMessage,
  type ConversationThread,
} from "../../api/conversationWire";
import {
  declaresConversationHello,
  declaresQueuedSends,
  declaresSteerSends,
  declaresStopSubagent,
} from "../../api/tailnetTransport";
import type { MobileSession } from "../../api/types";
import {
  conversationCanOperate,
  isStreamedEvent,
  keepUnchangedRows,
  mergeConversationEvents,
  projectConversation,
  recordValue,
  type ChangedTurn,
  type ConversationRow,
} from "./conversationLogic";
import type { AgentLane } from "./agentLogic";
import { chatWorksInBackground } from "./conversationListLogic";
import { keepUnchanged } from "./keepUnchanged";
import {
  loadConversationCache,
  updateConversationCache,
  MAX_PENDING_SENDS,
  type CachedConversation,
} from "../../storage/conversationCache";
import {
  conversationTranscripts,
  transcriptKey,
  type RememberedTranscript,
} from "../../storage/transcriptMemory";
import { createQueuedSendCourier } from "./queuedSendCourier";
import {
  cancelRefusal,
  heldByDesktop,
  holdsOnDesktop,
  queuedSendStale,
  stillHanding,
  type HandingSend,
} from "./queuedSends";

/**
 * How long a streamed delta may wait to be drawn with the ones behind it. A
 * reply arrives a token per frame; drawn one by one, each re-projected the
 * whole transcript on the JS thread. Fifty milliseconds is three frames at
 * 60Hz: long enough to draw a burst of tokens once, short enough that the
 * words still read as streaming.
 */
const STREAM_DRAW_MS = 50;
/**
 * How often a streaming reply is written to the phone's cache. Each write
 * serialises the chat's whole log, so one per frame kept the disk and the JS
 * thread busy for a reply's length. A write skipped is never lost: the next
 * one carries it, a turn's end or any event that is not a delta writes at
 * once, and leaving the chat or the app writes what was waiting. A phone
 * killed inside the window resumes from the cursor written with the log, so
 * the desktop sends what the cache did not keep.
 */
const STREAM_SAVE_MS = 1_000;

// Short of memory, the transcripts held for going back to a chat are the
// first thing to give up: each is a whole chat's log, and every one can be
// read again from the cache or the desktop, where an app the OS kills for
// memory loses everything. React Native raises the warning on iOS only.
AppState.addEventListener("memoryWarning", () => conversationTranscripts.shed());

/** Sends what a closed chat still had queued (`queuedSendCourier.ts`). */
const queuedSends = createQueuedSendCourier({
  load: loadConversationCache,
  update: updateConversationCache,
  watchForeground(onForeground) {
    let backgroundAt: number | null = AppState.currentState === "active" ? null : Date.now();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && backgroundAt !== null) {
        onForeground(Date.now() - backgroundAt);
        backgroundAt = null;
      } else if (next !== "active" && backgroundAt === null) backgroundAt = Date.now();
    });
    return () => subscription.remove();
  },
});

/** What to tell the person when the desktop refused something without saying why. */
function refusalText(code: string | undefined, fallback: string): string {
  if (code === "too_large") return "This message is too large for the desktop.";
  if (code === "busy") return "The desktop is busy. Try again in a moment.";
  if (code === "conversation_operate_required")
    return "This phone can read this conversation but not send to it.";
  if (code === "unsupported_model")
    return "That model is not in this chat's list on the desktop.";
  if (code === "unsupported_command")
    return "This desktop does not support that. Update Studio there.";
  return fallback;
}
type Cursor = { lastSeq: number; generation?: string };
const cursorOf = (held: { lastSeq: number; generation?: string }): Cursor => ({
  lastSeq: held.lastSeq,
  ...(held.generation === undefined ? {} : { generation: held.generation }),
});
/**
 * A transcript reopened without a page from the desktop reaches back to older
 * turns from the oldest event it holds.
 */
function pageHeld(events: ConversationEvent[]) {
  const oldest = events.reduce<number | null>(
    (seq, event) =>
      event.seq === undefined ? seq : Math.min(seq ?? event.seq, event.seq),
    null,
  );
  return oldest !== null && oldest > 1 ? oldest : null;
}
// A change to the chat itself (its model, its permission preset) waiting on
// the desktop's answer. The thread takes the change only once it is accepted.
type PendingThreadChange = {
  patch: Partial<Pick<ConversationThread, "modelId" | "permissionPreset">>;
  /** Said when the desktop refuses without a reason. */
  refused: string;
  /** Said when the link drops before the desktop answered. */
  lost: string;
  settle: (result: ModelSwitchResult) => void;
};
function abandonThreadChanges(
  pending: Map<string, PendingThreadChange>,
  lost?: string,
) {
  for (const entry of pending.values())
    entry.settle({ ok: false, message: lost ?? entry.lost });
  pending.clear();
}
/** How taking back a message the desktop holds ended: given back, or refused with why. */
export type CancelHeldResult = { ok: true } | { ok: false; message: string };
/** How an agent's Stop ended: the desktop took it (the agent then reports its end), or refused it with why. */
export type StopAgentResult = { ok: true } | { ok: false; message: string };
/** How a model switch or preset change ended: accepted (with the desktop's caveat, if any) or refused with why. */
export type ModelSwitchResult =
  | { ok: true; notice?: string }
  | { ok: false; message: string };
type Request = ConversationClientFrame extends infer F
  ? F extends { requestId: string }
    ? Omit<F, "requestId">
    : never
  : never;
export function usePhoneConversation(
  session: MobileSession | undefined,
  thread: ConversationThread,
  apiOverride?: ConversationApi,
) {
  const api = useMemo(
    () =>
      apiOverride ??
      (session
        ? createTailnetConversationsApi({
            baseUrl: session.baseUrl,
            deviceToken: session.deviceToken,
          })
        : null),
    [session?.baseUrl, session?.deviceToken, apiOverride],
  );
  // A chat opened earlier in this run draws what it held at once, on the
  // first frame, and then asks the desktop only for what followed.
  const remembered = (): RememberedTranscript | null =>
    session && !apiOverride
      ? conversationTranscripts.recall(transcriptKey(session.deviceId, thread))
      : null;
  const [events, setEvents] = useState<ConversationEvent[]>(
    () => remembered()?.events ?? [],
  );
  const [state, setState] = useState<ConversationConnectionState>("connecting");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(() => {
    const before = pageHeld(events);
    return { hasMore: before !== null, beforeCursor: before };
  });
  // `uploads`: the pictures it carries, by upload id, which its bubble draws
  // from the phone's own copies until the desktop's echo of it arrives.
  // `waiting`: the desktop turned it away behind a turn this phone had not
  // heard of, and it goes when that turn ends. `stale`: it waited across an
  // absence too long to go without asking (`queuedSends.ts`), and waits on
  // Send now or Discard; `queuedAt` says when it was written.
  const [optimistic, setOptimistic] = useState<
    {
      commandId: string;
      text: string;
      uploads?: string[];
      failed?: string;
      waiting?: boolean;
      stale?: boolean;
      queuedAt?: number;
    }[]
  >([]);
  const [queued, setQueued] = useState<
    { commandId: string; text: string; uploads: string[] }[]
  >([]);
  // What the desktop says it holds for this chat (`conversation-queued-sends`),
  // as its latest `queued` frame said it: the one list of what waits there.
  const [desktopHeld, setDesktopHeld] = useState<ConversationQueuedMessage[]>([]);
  // Messages offered to the desktop to hold that its list does not name yet.
  const [handing, setHanding] = useState<HandingSend[]>([]);
  const [pendingActionIds, setPendingActionIds] = useState<Set<string>>(
    new Set(),
  );
  // Why the desktop refused an answer to a request, by request id. Said on the
  // request's own card, where the person just tapped, and gone with the
  // request: the chat-wide notice kept "This request can only be allowed
  // once." under the title long after the request itself was answered.
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [effectiveThread, setEffectiveThread] = useState(thread);
  // The chat's title summary as the desktop's list last said it while this
  // screen was open; null until read. The desktop writes it a few seconds
  // after the first message, so the title the chat opened with is often
  // its first words, or "Chat N" for one started with pictures.
  const [listedTitle, setListedTitle] = useState<string | null>(null);
  const stream = useRef<ConversationStream | null>(null);
  const eventsRef = useRef<ConversationEvent[]>([]);
  const pendingRef = useRef<CachedConversation["pending"]>([]);
  // Where this phone is in the desktop's log: persisted with the events so a
  // reopened conversation resumes from it instead of reloading a snapshot.
  const cursorRef = useRef<Cursor>({ lastSeq: 0 });
  const sendChain = useRef<Promise<unknown>>(Promise.resolve());
  // Sends being written to the cache now: one may land after the screen closes.
  const sendsWriting = useRef(0);
  const lifecycle = useRef(0);
  const actionRequests = useRef(new Map<string, string>());
  // Model switches and preset changes waiting on their commandResult, by command id.
  const threadChanges = useRef(new Map<string, PendingThreadChange>());
  // Held messages being taken back (`cancelQueued`), by command id.
  const cancellations = useRef(new Map<string, (result: CancelHeldResult) => void>());
  // Agents being stopped by their own Stop (`stopSubagent`), by command id.
  const agentStops = useRef(new Map<string, { laneId: string; settle: (result: StopAgentResult) => void }>());
  // The lanes whose Stop is on its way or taken, until the agent reports its
  // end (its lane stops running) or the desktop refuses: the Stop says
  // "Stopping" meanwhile, and is not sent twice.
  const [stoppingAgentIds, setStoppingAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  // Whether the desktop holds queued messages; re-read on every foreground, so
  // a desktop that updates starts holding them without a re-pair.
  const holdsQueued = !!session && declaresQueuedSends(session);
  const takesSteer = !!session && declaresSteerSends(session);
  // Whether an agent of this chat can be stopped by itself from here: the
  // desktop takes the command and this pairing may drive its chats. Whether
  // the chat's own CLI can is its listed `capabilities.stopSubagent`.
  const stopsAgents = !!session && declaresStopSubagent(session) && conversationCanOperate(session);
  // Whether the socket's probe can be the cheap `hello` rather than a `list`.
  const answersHello = !!session && declaresConversationHello(session);
  // Read by a send as it is made: a turn running, and messages the phone holds.
  const turnBusyRef = useRef(false);
  const phoneQueuedRef = useRef(0);

  const metadataInFlight = useRef<Promise<void> | null>(null);
  const metadataAgain = useRef(false);
  const requests = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  // The rows and agents last handed out: a new projection keeps whatever has
  // not changed as the object it was, so only what changed is drawn again.
  const shown = useRef<{ rows: ConversationRow[]; lanes: AgentLane[]; changedTurns: ChangedTurn[] }>({
    rows: [],
    lanes: [],
    changedTurns: [],
  });
  const projection = useMemo(() => {
    const projected = projectConversation(events);
    const rows = keepUnchangedRows(shown.current.rows, projected.rows);
    const lanes = keepUnchanged(shown.current.lanes, projected.lanes, (lane) => lane.id);
    const changedTurns = keepUnchanged(shown.current.changedTurns, projected.changedTurns, (turn) => turn.id);
    shown.current = { rows, lanes, changedTurns };
    return { ...projected, rows, lanes, changedTurns };
  }, [events]);
  turnBusyRef.current = projection.turnBusy;
  phoneQueuedRef.current = queued.length;
  const requestsRef = requests.current;
  const cacheKey = useMemo(
    () => ({ workspaceId: thread.workspaceId, agentId: thread.agentId }),
    [thread.workspaceId, thread.agentId],
  );
  const deviceId = session?.deviceId;
  const memoryKey = useMemo(
    () =>
      deviceId !== undefined && !apiOverride
        ? transcriptKey(deviceId, cacheKey)
        : null,
    [deviceId, apiOverride, cacheKey],
  );
  // What the screen holds now, captured for the disk write that follows and
  // remembered for the next time this chat is opened.
  const held = useCallback(() => {
    if (memoryKey)
      conversationTranscripts.remember(memoryKey, {
        events: eventsRef.current,
        ...cursorRef.current,
      });
    return { events: eventsRef.current, cursor: cursorRef.current };
  }, [memoryKey]);
  const persist = useCallback(
    async (
      // Captured together when the frame was applied: the write runs later,
      // after newer frames may have moved the live cursor past these events.
      { events, cursor }: { events: ConversationEvent[]; cursor: Cursor },
      acknowledged: string[] = [],
      reset = false,
    ) => {
      const owner = lifecycle.current;
      if (!session || apiOverride) {
        pendingRef.current = pendingRef.current.filter(
          (item) => !acknowledged.includes(item.commandId),
        );
        return;
      }
      const saved = await updateConversationCache(
        session.deviceId,
        cacheKey,
        (current) => {
          const pending = current.pending.filter(
            (item) => !acknowledged.includes(item.commandId),
          );
          // A reset, or a cache from another generation of the log, is
          // replaced outright: its events and cursor describe a log that no
          // longer exists.
          if (reset || current.generation !== cursor.generation)
            return {
              events: [...events],
              pending,
              lastSeq: cursor.lastSeq,
              ...(cursor.generation === undefined
                ? {}
                : { generation: cursor.generation }),
            };
          // Cached deltas are coalesced. Never merge them back into a raw
          // event list; keep whichever screen's copy is further along.
          const newer = cursor.lastSeq >= current.lastSeq;
          return {
            ...current,
            events: newer ? [...events] : current.events,
            pending,
            lastSeq: Math.max(current.lastSeq, cursor.lastSeq),
          };
        },
      );
      if (owner === lifecycle.current) pendingRef.current = saved.pending;
    },
    [session?.deviceId, apiOverride, cacheKey],
  );
  const mutatePending = useCallback(
    async (change: {
      add?: CachedConversation["pending"][number];
      remove?: string;
      /** Rewrite one entry where it stands: a send now held, found stale, or sent again. */
      patch?: {
        commandId: string;
        update: (
          item: CachedConversation["pending"][number],
        ) => CachedConversation["pending"][number];
      };
    }) => {
      const owner = lifecycle.current;
      const patched = (pending: CachedConversation["pending"]) =>
        change.patch
          ? pending.map((item) =>
              item.commandId === change.patch!.commandId ? change.patch!.update(item) : item,
            )
          : pending;
      if (!session || apiOverride) {
        pendingRef.current = patched(
          pendingRef.current.filter((item) => item.commandId !== change.remove),
        );
        if (change.add)
          pendingRef.current = [...pendingRef.current, change.add];
        return;
      }
      const saved = await updateConversationCache(
        session.deviceId,
        cacheKey,
        (current) => ({
          ...current,
          pending: [
            ...patched(
              current.pending.filter(
                (item) =>
                  item.commandId !== change.remove &&
                  item.commandId !== change.add?.commandId,
              ),
            ),
            ...(change.add ? [change.add] : []),
          ],
        }),
      );
      if (owner === lifecycle.current) pendingRef.current = saved.pending;
    },
    [session?.deviceId, apiOverride, cacheKey],
  );
  const serialize = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    const owner = lifecycle.current;
    const result = sendChain.current.then(() => {
      if (owner !== lifecycle.current)
        throw new Error("Conversation changed before the action completed.");
      return work();
    });
    sendChain.current = result.catch(() => {});
    return result;
  }, []);
  // Frames arrive faster than the disk takes them while a reply streams, and
  // each write queued in the same line as a send. Only the newest of the
  // writes waiting there is made: it carries the acknowledgments and any
  // reset of the ones it replaces, so the disk ends as it would have, and a
  // send queued behind a stream waits for one write rather than one per frame.
  const unsaved = useRef({
    latest: 0,
    acknowledged: new Set<string>(),
    reset: false,
  });
  // The streamed write waiting out its window, and when the last one went.
  const streamSave = useRef<{
    at: number;
    timer: ReturnType<typeof setTimeout> | null;
    snapshot: { events: ConversationEvent[]; cursor: Cursor } | null;
  }>({ at: 0, timer: null, snapshot: null });
  const persistLatest = useCallback(
    (
      snapshot: { events: ConversationEvent[]; cursor: Cursor },
      acknowledged: string[] = [],
      reset = false,
    ) => {
      // This write holds the newest log, so a streamed one waiting is moot.
      const waiting = streamSave.current;
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.timer = null;
      waiting.snapshot = null;
      const queue = unsaved.current;
      const mine = ++queue.latest;
      for (const id of acknowledged) queue.acknowledged.add(id);
      if (reset) queue.reset = true;
      return serialize(async () => {
        if (mine !== queue.latest) return;
        const carried = [...queue.acknowledged];
        const replaces = queue.reset;
        queue.acknowledged = new Set();
        queue.reset = false;
        await persist(snapshot, carried, replaces);
      });
    },
    [persist, serialize],
  );
  // A delta's write: at once if none went inside the window, else the newest
  // waits for the window's end.
  const persistStreamed = useCallback(
    (snapshot: { events: ConversationEvent[]; cursor: Cursor }) => {
      const waiting = streamSave.current;
      const wait = waiting.at + STREAM_SAVE_MS - Date.now();
      if (wait <= 0) {
        waiting.at = Date.now();
        return persistLatest(snapshot);
      }
      waiting.snapshot = snapshot;
      waiting.timer ??= setTimeout(() => {
        const held = waiting.snapshot;
        waiting.timer = null;
        if (!held) return;
        waiting.at = Date.now();
        void persistLatest(held).catch(() => {});
      }, wait);
      return Promise.resolve();
    },
    [persistLatest],
  );
  const refreshMetadata = useCallback(() => {
    if (!api) return;
    // Asked for while a read is out: that read may have been answered before
    // what asked, so one more follows it. A background agent's end, read too
    // early, would leave the chat working in the background for good.
    if (metadataInFlight.current) {
      metadataAgain.current = true;
      return;
    }
    const owner = lifecycle.current;
    const read = api
      .list()
      .then((threads) => {
        if (owner !== lifecycle.current) return;
        const latest = threads.find(
          (item) =>
            item.workspaceId === cacheKey.workspaceId &&
            item.agentId === cacheKey.agentId,
        );
        if (!latest) return;
        setEffectiveThread(latest);
        setListedTitle(latest.chatTitle?.trim() || null);
      })
      .catch(() => {
        /* Keep the last known metadata when the desktop is briefly offline. */
      })
      .finally(() => {
        if (metadataInFlight.current !== read) return;
        metadataInFlight.current = null;
        if (metadataAgain.current && owner === lifecycle.current) {
          metadataAgain.current = false;
          refreshMetadata();
        }
      });
    metadataInFlight.current = read;
  }, [api, cacheKey]);
  useEffect(() => {
    lifecycle.current++;
    let disposed = false;
    // The map outlives every effect run; held here so the cleanup settles the
    // same one the handlers below fill.
    const switches = threadChanges.current;
    const takingBack = cancellations.current;
    const stopping = agentStops.current;
    // An agent's Stop that will not be answered now: its lane offers Stop again.
    const abandonAgentStops = (message: string) => {
      for (const { settle } of stopping.values()) settle({ ok: false, message });
      stopping.clear();
      setStoppingAgentIds(new Set());
    };
    let current: ConversationStream | null = null;
    let subscription: ReturnType<typeof AppState.addEventListener> | null =
      null;
    // A streamed delta joins the log at once and is drawn with the others in
    // its window; anything else draws the log there and then, deltas and all.
    let drawTimer: ReturnType<typeof setTimeout> | null = null;
    const drawLog = (streamed: boolean) => {
      if (streamed) {
        drawTimer ??= setTimeout(() => {
          drawTimer = null;
          if (!disposed) setEvents(eventsRef.current);
        }, STREAM_DRAW_MS);
        return;
      }
      if (drawTimer) clearTimeout(drawTimer);
      drawTimer = null;
      setEvents(eventsRef.current);
    };
    const recalled = memoryKey ? conversationTranscripts.recall(memoryKey) : null;
    // This screen offers the chat's queued messages from here on, not the
    // stream that carried them while it was closed.
    const durable = session && !apiOverride ? session.deviceId : null;
    if (durable !== null) queuedSends.release(durable, cacheKey);
    const writing = sendsWriting;
    eventsRef.current = recalled?.events ?? [];
    pendingRef.current = [];
    unsaved.current = { latest: 0, acknowledged: new Set(), reset: false };
    const streamed = (streamSave.current = { at: 0, timer: null, snapshot: null });
    // What a streaming reply had waiting, written now: on leaving the chat
    // straight to the cache, since the line of writes no longer takes this
    // chat's, and on leaving the app through it.
    const saveWaiting = (direct: boolean) => {
      const held = streamed.snapshot;
      if (streamed.timer) clearTimeout(streamed.timer);
      streamed.timer = null;
      streamed.snapshot = null;
      if (!held) return;
      void (direct ? persist(held) : persistLatest(held)).catch(() => {});
    };
    cursorRef.current = recalled ? cursorOf(recalled) : { lastSeq: 0 };
    actionRequests.current.clear();
    setPendingActionIds(new Set());
    setEffectiveThread(thread);
    setListedTitle(null);
    setEvents(eventsRef.current);
    setOptimistic([]);
    setQueued([]);
    setDesktopHeld([]);
    setHanding([]);
    const recalledPage = pageHeld(eventsRef.current);
    setPage({ hasMore: recalledPage !== null, beforeCursor: recalledPage });
    if (!api) {
      setState("blocked");
      setNotice("Pair this desktop to open its conversation.");
      return;
    }
    const start = async () => {
      const cached =
        session && !apiOverride
          ? await loadConversationCache(session.deviceId, cacheKey)
          : null;
      if (disposed) return;
      pendingRef.current = cached?.pending ?? [];
      // The remembered transcript is written on every frame applied and the
      // disk only after it, so the disk is newer only when another screen on
      // the same chat wrote it since.
      const diskIsNewer =
        cached !== null &&
        (!recalled ||
          (cached.generation === recalled.generation &&
            cached.lastSeq > recalled.lastSeq));
      if (diskIsNewer) {
        eventsRef.current = cached.events;
        cursorRef.current = cursorOf(cached);
        setEvents(eventsRef.current);
        held();
        // A resume that sends only missed events brings no page, so the way
        // back to older turns starts from the oldest event held here.
        const oldest = pageHeld(eventsRef.current);
        if (oldest !== null) setPage({ hasMore: true, beforeCursor: oldest });
      }
      // What waited too long while the chat was closed is drawn as not sent
      // at once, before the desktop answers: the stream will not offer it
      // (`queuedSends.ts`), and the person decides.
      const openedAt = Date.now();
      const staleAtOpen = new Set(
        pendingRef.current
          .filter((item) => queuedSendStale(item, openedAt))
          .map((item) => item.commandId),
      );
      setOptimistic(
        pendingRef.current.map((item) => {
          const queuedAt = item.queuedAt ?? item.command.composedAt;
          return {
            commandId: item.commandId,
            text: item.command.message,
            ...(item.command.uploadIds?.length ? { uploads: item.command.uploadIds } : {}),
            ...(staleAtOpen.has(item.commandId) ? { stale: true } : {}),
            ...(queuedAt !== undefined ? { queuedAt } : {}),
          };
        }),
      );
      // A send cached as handed to the desktop is offered to it again
      // under its id (the desktop holds a repeat once); to a desktop that has
      // since lost the capability it waits here like any other.
      const handed = (item: CachedConversation["pending"][number]) =>
        item.command.queue === true && holdsQueued;
      setQueued(
        pendingRef.current
          .filter((item) => !handed(item) && !staleAtOpen.has(item.commandId))
          .map((item) => ({
            commandId: item.commandId,
            text: item.command.message,
            uploads: item.command.uploadIds ?? [],
          })),
      );
      setHanding(
        pendingRef.current
          .filter((item) => handed(item) && !staleAtOpen.has(item.commandId))
          .map((item) => ({ commandId: item.commandId, text: item.command.message })),
      );
      current = api.open(
        cacheKey,
        cursorRef.current.lastSeq,
        {
          onState(next, detail) {
            if (!disposed) {
              setState(next);
              setNotice(detail ?? "");
              if (next !== "live") {
                actionRequests.current.clear();
                setPendingActionIds(new Set());
                // A change sent before the drop may still have been applied;
                // the list read on reconnect says where the chat stands.
                abandonThreadChanges(switches);
                // As may a message taken back: the list the desktop sends
                // after the redial says whether it still holds it.
                for (const settle of takingBack.values())
                  settle({ ok: false, message: "The desktop disconnected before answering. Check the queue once it reconnects." });
                takingBack.clear();
                // A Stop sent before the drop may still have landed; the
                // agent's lane says so once the transcript catches up.
                abandonAgentStops("The desktop disconnected before answering. If the agent is still working, stop it again.");
              }
            }
          },
          onSendStarted(commandId) {
            if (!disposed)
              setQueued((previous) =>
                previous.filter((item) => item.commandId !== commandId),
              );
          },
          onSendWaiting(commandId) {
            if (disposed) return;
            setOptimistic((previous) =>
              previous.some((item) => item.commandId === commandId && !item.waiting)
                ? previous.map((item) => (item.commandId === commandId ? { ...item, waiting: true } : item))
                : previous,
            );
          },
          // Turned away behind a turn, and now the desktop's to send when it
          // ends: drawn as on its way to its list, and kept as held, so a
          // stream that takes it over from the cache offers it as one.
          onSendHeld(commandId, command, heldAfter) {
            if (disposed) return;
            setQueued((previous) => previous.filter((item) => item.commandId !== commandId));
            setHanding((previous) =>
              previous.some((item) => item.commandId === commandId)
                ? previous
                : [...previous, { commandId, text: command.message }],
            );
            void serialize(async () => {
              await mutatePending({
                patch: { commandId, update: (item) => ({ ...item, command, heldAfter }) },
              });
            }).catch(() => {
              if (!disposed) setNotice("Conversation cache could not be saved.");
            });
          },
          // No longer sent without asking: Not sent, with Send now and
          // Discard, and kept so across a restart until the person decides.
          onSendStale(commandId) {
            if (disposed) return;
            setQueued((previous) => previous.filter((item) => item.commandId !== commandId));
            setHanding((previous) => previous.filter((item) => item.commandId !== commandId));
            const entry = pendingRef.current.find((item) => item.commandId === commandId);
            const queuedAt = entry?.queuedAt ?? entry?.command.composedAt;
            setOptimistic((previous) =>
              previous.map((item) =>
                item.commandId === commandId
                  ? {
                      ...item,
                      stale: true,
                      waiting: false,
                      ...(queuedAt !== undefined ? { queuedAt } : {}),
                    }
                  : item,
              ),
            );
            void serialize(async () => {
              await mutatePending({
                patch: { commandId, update: (item) => ({ ...item, stale: true }) },
              });
            }).catch(() => {
              if (!disposed) setNotice("Conversation cache could not be saved.");
            });
          },
          onFrame(frame) {
            if (disposed) return;
            if (frame.type === "snapshot") {
              eventsRef.current = frame.reset
                ? frame.page.events
                : mergeConversationEvents(eventsRef.current, frame.page.events);
              const newest = frame.page.events.reduce(
                (seq, item) => Math.max(seq, item.seq ?? 0),
                0,
              );
              cursorRef.current = frame.reset
                ? {
                    lastSeq: newest,
                    ...(frame.generation === undefined
                      ? {}
                      : { generation: frame.generation }),
                  }
                : {
                    ...cursorRef.current,
                    lastSeq: Math.max(cursorRef.current.lastSeq, newest),
                  };
              drawLog(false);
              const acknowledgments = new Set(
                frame.page.events
                  .filter((item) => item.type === "user_message")
                  .map((item) => item.payload?.commandId)
                  .filter((id): id is string => typeof id === "string"),
              );
              void persistLatest(
                held(),
                [...acknowledgments],
                frame.reset === true,
              ).catch(() => {
                if (!disposed)
                  setNotice("Conversation cache could not be saved.");
              });
              setQueued((previous) =>
                previous.filter((item) => !acknowledgments.has(item.commandId)),
              );
              setOptimistic((previous) =>
                previous.filter((item) => !acknowledgments.has(item.commandId)),
              );
              if (
                frame.page.events.some(
                  (item) =>
                    item.type === "session_started" ||
                    item.type === "session_updated",
                )
              )
                refreshMetadata();
              setPage({
                hasMore: frame.page.hasMore,
                beforeCursor: frame.page.beforeCursor,
              });
            } else if (frame.type === "synchronized") {
              // The fence vouches for everything up to its sequence, in its
              // generation: from here a reconnect needs only what follows.
              const generation =
                frame.generation ?? cursorRef.current.generation;
              cursorRef.current = {
                lastSeq: frame.seq,
                ...(generation === undefined ? {} : { generation }),
              };
              void persistLatest(held()).catch(() => {
                if (!disposed)
                  setNotice("Conversation cache could not be saved.");
              });
            } else if (frame.type === "event") {
              eventsRef.current = mergeConversationEvents(eventsRef.current, [
                frame.event,
              ]);
              cursorRef.current = {
                ...cursorRef.current,
                lastSeq: Math.max(
                  cursorRef.current.lastSeq,
                  frame.event.seq ?? 0,
                ),
              };
              drawLog(isStreamedEvent(frame.event));
              if (
                (frame.event.type === "session_started" ||
                  frame.event.type === "session_updated") &&
                frame.event.sessionId
              ) {
                setEffectiveThread((previous) => ({
                  ...previous,
                  sessionId: frame.event.sessionId,
                }));
                refreshMetadata();
              }
              // A turn's end is when its chat's title summary has landed on
              // the desktop: it is written while the first turn runs. An
              // agent's end can be the last of the chat's background work,
              // which the desktop's list says.
              if (
                frame.event.type === "turn_completed" ||
                frame.event.type === "turn_failed" ||
                (frame.event.type === "subagent_status" &&
                  frame.event.payload?.status !== "running")
              )
                refreshMetadata();
              const commandId =
                frame.event.type === "user_message"
                  ? frame.event.payload?.commandId
                  : undefined;
              if (typeof commandId === "string") {
                setQueued((previous) =>
                  previous.filter((item) => item.commandId !== commandId),
                );
                setOptimistic((previous) =>
                  previous.filter((item) => item.commandId !== commandId),
                );
              }
              void (
                typeof commandId !== "string" && isStreamedEvent(frame.event)
                  ? persistStreamed(held())
                  : persistLatest(
                      held(),
                      typeof commandId === "string" ? [commandId] : [],
                    )
              ).catch(() => {
                if (!disposed)
                  setNotice("Conversation cache could not be saved.");
              });
              if (
                [
                  "approval_resolved",
                  "question_resolved",
                  "plan_resolved",
                ].includes(frame.event.type)
              ) {
                const requestId = frame.event.payload?.requestId;
                if (typeof requestId === "string")
                  setPendingActionIds((previous) => {
                    const next = new Set(previous);
                    next.delete(requestId);
                    return next;
                  });
              }
            } else if (frame.type === "result") {
              const request = requestsRef.get(frame.requestId);
              if (request) {
                clearTimeout(request.timer);
                requestsRef.delete(frame.requestId);
                if (frame.ok) request.resolve(frame.data);
                else
                  // The desktop's own words, else what its code means: a
                  // bare "unavailable" or "not_found" told nobody anything.
                  request.reject(
                    new Error(
                      typeof frame.message === "string" && frame.message.trim()
                        ? frame.message.trim()
                        : refusalText(frame.code, "The desktop could not answer that. Try again."),
                    ),
                  );
              }
            } else if (frame.type === "queued") {
              // The desktop's word on what it holds stands whole: a message
              // sent, taken back elsewhere or refused when its turn came is
              // already as it should be here.
              setDesktopHeld(frame.messages);
              // A held send found stale here that the desktop's list names
              // after all reached it before its answer was lost: the list
              // draws it, with its own Edit and Remove.
              const reachedDesktop = pendingRef.current
                .filter(
                  (item) =>
                    item.stale === true &&
                    item.command.queue === true &&
                    heldByDesktop(frame.messages, item.command.message),
                )
                .map((item) => item.commandId);
              if (reachedDesktop.length) {
                setOptimistic((shown) => shown.filter((item) => !reachedDesktop.includes(item.commandId)));
                for (const commandId of reachedDesktop) {
                  current?.cancelPending(commandId);
                  void serialize(async () => {
                    await mutatePending({ remove: commandId });
                  }).catch(() => {
                    if (!disposed) setNotice("Conversation cache could not be saved.");
                  });
                }
              }
              setHanding((previous) => {
                const next = stillHanding(previous, frame.messages);
                // One the list now names is drawn from it alone, never also
                // as a message on its way.
                if (next !== previous) {
                  const taken = new Set(previous.filter((item) => !next.includes(item)).map((item) => item.commandId));
                  setOptimistic((shown) => shown.filter((item) => !taken.has(item.commandId) || item.failed !== undefined));
                }
                return next;
              });
            } else if (
              frame.type === "commandResult" &&
              takingBack.has(frame.commandId)
            ) {
              const settle = takingBack.get(frame.commandId)!;
              takingBack.delete(frame.commandId);
              settle(frame.ok ? { ok: true } : { ok: false, message: cancelRefusal(frame.message) });
            } else if (frame.type === "commandResult" && stopping.has(frame.commandId)) {
              const { laneId, settle } = stopping.get(frame.commandId)!;
              stopping.delete(frame.commandId);
              if (frame.ok) settle({ ok: true });
              else {
                // Refused: the agent works on, and its lane offers Stop again.
                setStoppingAgentIds((previous) => {
                  const next = new Set(previous);
                  next.delete(laneId);
                  return next;
                });
                settle({
                  ok: false,
                  message: conversationSessionWasLost(frame)
                    ? "The server running this chat restarted, and its agents ended with it."
                    : (frame.message ?? refusalText(frame.code, "The desktop could not stop this agent.")),
                });
              }
            } else if (
              frame.type === "commandResult" &&
              switches.has(frame.commandId)
            ) {
              const pending = switches.get(frame.commandId)!;
              switches.delete(frame.commandId);
              if (frame.ok) {
                setEffectiveThread((previous) => ({
                  ...previous,
                  ...pending.patch,
                }));
                refreshMetadata();
                pending.settle({
                  ok: true,
                  ...(frame.notice ? { notice: frame.notice } : {}),
                });
              } else
                pending.settle({
                  ok: false,
                  message: conversationSessionWasLost(frame)
                    ? "The server running this chat restarted before the change landed. Try again."
                    : (frame.message ?? refusalText(frame.code, pending.refused)),
                });
            } else if (frame.type === "commandResult") {
              const requestId = actionRequests.current.get(frame.commandId);
              const reason = frame.ok
                ? ""
                : requestId && conversationSessionWasLost(frame)
                  ? LOST_REQUEST_SENTENCE
                  : (frame.message ??
                    refusalText(frame.code, "Desktop refused this action."));
              if (!frame.ok && requestId)
                setActionErrors((previous) => ({ ...previous, [requestId]: reason }));
              else if (!frame.ok) setNotice(reason);
              // A refused send leaves the durable queue for good and stays on
              // screen, marked with why, until the person removes it.
              setOptimistic((previous) =>
                frame.ok
                  ? previous.filter(
                      (item) => item.commandId !== frame.commandId,
                    )
                  : previous.map((item) =>
                      item.commandId === frame.commandId
                        ? { ...item, failed: reason }
                        : item,
                    ),
              );
              setQueued((previous) =>
                previous.filter((item) => item.commandId !== frame.commandId),
              );
              // Held now, or refused: either way no longer on its way. A held
              // one stays drawn from the desktop's list, which named it first.
              setHanding((previous) =>
                previous.some((item) => item.commandId === frame.commandId)
                  ? previous.filter((item) => item.commandId !== frame.commandId)
                  : previous,
              );
              void serialize(async () => {
                await mutatePending({ remove: frame.commandId });
              }).catch(() => {
                if (!disposed)
                  setNotice("Conversation cache could not be saved.");
              });
              if (requestId) {
                actionRequests.current.delete(frame.commandId);
                setPendingActionIds((previous) => {
                  const next = new Set(previous);
                  next.delete(requestId);
                  return next;
                });
              }
            } else if (frame.type === "error") setNotice(frame.message);
          },
        },
        {
          pendingSends: pendingRef.current,
          ...(cursorRef.current.generation === undefined
            ? {}
            : { generation: cursorRef.current.generation }),
          initiallyBusy:
            thread.phase === "running" ||
            thread.phase === "waiting_for_approval" ||
            thread.phase === "waiting_for_input",
          queuedSends: holdsQueued,
          hello: answersHello,
        },
      );
      stream.current = current;
      let backgroundAt: number | null =
        AppState.currentState === "active" ? null : Date.now();
      subscription = AppState.addEventListener("change", (next) => {
        if (next === "active" && backgroundAt !== null) {
          current?.foreground(Date.now() - backgroundAt);
          backgroundAt = null;
        } else if (next !== "active" && backgroundAt === null) {
          backgroundAt = Date.now();
          saveWaiting(false);
        }
      });
    };
    void start().catch((error) => {
      if (!disposed) {
        setState("offline");
        setNotice(
          error instanceof Error ? error.message : "Conversation unavailable.",
        );
      }
    });
    return () => {
      disposed = true;
      if (drawTimer) clearTimeout(drawTimer);
      saveWaiting(true);
      lifecycle.current++;
      metadataInFlight.current = null;
      metadataAgain.current = false;
      subscription?.remove();
      current?.close();
      stream.current = null;
      // A message still queued goes on to the desktop without this screen.
      if (durable !== null && api && (pendingRef.current.length || writing.current))
        queuedSends.carry({ deviceId: durable, key: cacheKey, api, queuedSends: holdsQueued, hello: answersHello });
      actionRequests.current.clear();
      abandonThreadChanges(switches, "Conversation closed.");
      for (const settle of takingBack.values()) settle({ ok: false, message: "Conversation closed." });
      takingBack.clear();
      abandonAgentStops("Conversation closed.");
      for (const request of requestsRef.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Conversation closed."));
      }
      requestsRef.clear();
    };
  }, [
    api,
    cacheKey,
    session?.deviceId,
    apiOverride,
    thread.phase,
    requestsRef,
    persist,
    persistLatest,
    persistStreamed,
    mutatePending,
    serialize,
    refreshMetadata,
    memoryKey,
    held,
    holdsQueued,
    answersHello,
  ]);
  const command = useCallback((input: ConversationCommand) => {
    if (!stream.current) throw new Error("Conversation is not connected yet.");
    if (input.kind === "send")
      throw new Error("Use the durable send queue for messages.");
    const commandId = stream.current.command(input);
    if (input.kind === "resolveApproval" || input.kind === "answerQuestion" || input.kind === "resolvePlan") {
      actionRequests.current.set(commandId, input.requestId);
      setPendingActionIds((previous) => new Set(previous).add(input.requestId));
      setActionErrors((previous) => {
        if (!(input.requestId in previous)) return previous;
        const next = { ...previous };
        delete next[input.requestId];
        return next;
      });
    }
    return commandId;
  }, []);
  // Send a change to the chat itself. Settles when the desktop answers; the
  // thread shows the change only once the desktop has accepted it.
  const changeThread = useCallback(
    (
      input: Extract<ConversationCommand, { kind: "setModel" | "setPermissionPreset" }>,
      change: Omit<PendingThreadChange, "settle">,
    ): Promise<ModelSwitchResult> =>
      new Promise<ModelSwitchResult>((resolve) => {
        if (!stream.current) {
          resolve({ ok: false, message: "Conversation is not connected yet." });
          return;
        }
        let commandId: string;
        try {
          commandId = stream.current.command(input);
        } catch (error) {
          resolve({
            ok: false,
            message: error instanceof Error ? error.message : change.refused,
          });
          return;
        }
        threadChanges.current.set(commandId, { ...change, settle: resolve });
      }),
    [],
  );
  // Switch the chat to another model of its CLI.
  const setModel = useCallback(
    (modelId: string) =>
      changeThread(
        { kind: "setModel", modelId },
        {
          patch: { modelId },
          refused: "The desktop refused the model.",
          lost: "The desktop disconnected before confirming the model.",
        },
      ),
    [changeThread],
  );
  // Run the chat under another permission preset.
  const setPermissionPreset = useCallback(
    (preset: ConversationPermissionPreset) =>
      changeThread(
        { kind: "setPermissionPreset", preset },
        {
          patch: { permissionPreset: preset },
          refused: "The desktop refused the permission change.",
          lost: "The desktop disconnected before confirming the permission change.",
        },
      ),
    [changeThread],
  );
  // `steer` asks for the message to go into the running turn; it is honoured
  // only where the desktop takes one, with no pictures and a turn running, and
  // is otherwise an ordinary send (`followUp.ts`).
  const queueSend = useCallback(
    (message: string, uploadIds: string[] = [], options: { steer?: boolean } = {}): Promise<string> => {
      const owner = lifecycle.current;
      const sendingStream = stream.current;
      const run = async () => {
        if (
          !sendingStream ||
          stream.current !== sendingStream ||
          owner !== lifecycle.current
        )
          throw new Error("Conversation is not connected yet.");
        sendsWriting.current++;
        try {
          return await write(sendingStream);
        } finally {
          sendsWriting.current--;
        }
      };
      const write = async (sendingStream: ConversationStream) => {
        if (pendingRef.current.length >= MAX_PENDING_SENDS)
          throw new Error(
            "Too many pending messages. Reconnect before sending more.",
          );
        const commandId = Crypto.randomUUID();
        // When the person pressed Send: kept with the queued entry, and told
        // to the desktop with the send (`composedAt`).
        const queuedAt = Date.now();
        // A steer goes now, like a send with no turn running: it is neither
        // held by the phone nor handed to the desktop to hold. Where the turn
        // cannot take it after all, the desktop holds it and its `queued`
        // frame draws it there.
        const steer =
          options.steer === true && takesSteer && turnBusyRef.current && uploadIds.length === 0;
        // Behind a running turn, a desktop that holds messages takes this
        // one now and sends it itself (`queuedSends.ts` says when not).
        const handOver = !steer && holdsOnDesktop({
          declared: holdsQueued,
          turnBusy: turnBusyRef.current,
          uploads: uploadIds.length,
          phoneQueued: phoneQueuedRef.current,
        });
        // One send is one message, whatever separators the text carries. A
        // held one carries no `uploadIds` at all: the desktop refuses `queue`
        // beside even an empty list.
        const command: Extract<ConversationCommand, { kind: "send" }> = steer
          ? { kind: "send", message: plainLineBreaks(message), steer: true, composedAt: queuedAt }
          : handOver
            ? { kind: "send", message: plainLineBreaks(message), queue: true, composedAt: queuedAt }
            : { kind: "send", message: plainLineBreaks(message), uploadIds, composedAt: queuedAt };
        // Checked before the outbox: a send the desktop must refuse would
        // otherwise be persisted and offered again on every reconnect.
        const problem = conversationSendProblem(commandId, command);
        if (problem) throw new Error(problem);
        // A handed-over send keeps the cursor it was queued at, so whichever
        // stream offers it from the cache later (the chat reopened, the
        // courier, the app restarted) can tell the desktop already sent it.
        await mutatePending({
          add: { commandId, command, queuedAt, ...(handOver ? { heldAfter: cursorRef.current.lastSeq } : {}) },
        });
        // A persisted send belongs to its original conversation even if navigation changed.
        if (owner !== lifecycle.current || stream.current !== sendingStream)
          return commandId;
        setOptimistic((previous) => [
          ...previous,
          {
            commandId,
            text: command.message,
            queuedAt,
            ...(command.uploadIds?.length ? { uploads: command.uploadIds } : {}),
          },
        ]);
        if (handOver)
          setHanding((previous) => [...previous, { commandId, text: command.message }]);
        else if (!steer) {
          // Counted at once, not on the next draw: a second message queued
          // straight after this one must see it and wait behind it.
          phoneQueuedRef.current++;
          setQueued((previous) => [
            ...previous,
            { commandId, text: command.message, uploads: uploadIds },
          ]);
        }
        sendingStream.command(command, commandId);
        return commandId;
      };
      return serialize(run);
    },
    [mutatePending, serialize, holdsQueued, takesSteer],
  );
  // Take back a message the desktop holds, by the id its list names it by.
  // Settles when the desktop answers; its next `queued` frame then leaves the
  // message out. Refused once the message is on its way into the chat.
  const cancelHeld = useCallback(
    (queuedId: string): Promise<CancelHeldResult> =>
      new Promise<CancelHeldResult>((resolve) => {
        if (!stream.current) {
          resolve({ ok: false, message: "Conversation is not connected yet." });
          return;
        }
        let commandId: string;
        try {
          commandId = stream.current.command({ kind: "cancelQueued", queuedId });
        } catch (error) {
          resolve({
            ok: false,
            message: error instanceof Error ? error.message : "Reconnect before using this action.",
          });
          return;
        }
        cancellations.current.set(commandId, resolve);
      }),
    [],
  );
  // An agent that has ended is stopping no more: dropped, so one resumed
  // later in the same lane (SendMessage) offers its Stop again.
  useEffect(() => {
    setStoppingAgentIds((previous) => {
      if (!previous.size) return previous;
      const next = new Set(
        [...previous].filter((id) => projection.lanes.some((lane) => lane.id === id && lane.status === "running")),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [projection.lanes]);
  // Stop one agent the chat spawned, by its lane (the call that spawned it),
  // leaving the chat and its turn running. Settles when the desktop answers;
  // the agent then reports its own end, which stops its lane running.
  const stopAgent = useCallback(
    (laneId: string): Promise<StopAgentResult> =>
      new Promise<StopAgentResult>((resolve) => {
        if (!stream.current) {
          resolve({ ok: false, message: "Conversation is not connected yet." });
          return;
        }
        let commandId: string;
        try {
          commandId = stream.current.command({ kind: "stopSubagent", toolUseId: laneId });
        } catch (error) {
          resolve({
            ok: false,
            message: error instanceof Error ? error.message : "Reconnect before using this action.",
          });
          return;
        }
        agentStops.current.set(commandId, { laneId, settle: resolve });
        setStoppingAgentIds((previous) => new Set(previous).add(laneId));
      }),
    [],
  );
  const cancelQueued = useCallback(
    (commandId: string): Promise<void> => {
      const owner = lifecycle.current;
      const sendingStream = stream.current;
      const run = async () => {
        await mutatePending({ remove: commandId });
        if (owner !== lifecycle.current || stream.current !== sendingStream)
          return;
        sendingStream?.cancelPending(commandId);
        setQueued((previous) =>
          previous.filter((item) => item.commandId !== commandId),
        );
        setOptimistic((previous) =>
          previous.filter((item) => item.commandId !== commandId),
        );
      };
      return serialize(run);
    },
    [mutatePending, serialize],
  );
  // Send a message that was not sent without asking (`stale`), now the
  // person asks: the same send under its id, marked confirmed, so neither
  // this phone's rule nor the desktop's holds it back again. It is then a
  // waiting send like any other: held by the desktop if it was handed there,
  // else waiting here for the turn.
  const sendNow = useCallback(
    (commandId: string): Promise<void> => {
      const owner = lifecycle.current;
      const sendingStream = stream.current;
      const run = async () => {
        if (!sendingStream || stream.current !== sendingStream || owner !== lifecycle.current)
          throw new Error("Conversation is not connected yet.");
        const entry = pendingRef.current.find((item) => item.commandId === commandId);
        if (!entry) return;
        const command = { ...entry.command, confirmedStale: true as const };
        await mutatePending({
          patch: {
            commandId,
            update: ({ stale: _stale, ...item }) => ({ ...item, command }),
          },
        });
        if (owner !== lifecycle.current || stream.current !== sendingStream) return;
        setOptimistic((previous) =>
          previous.map((item) =>
            item.commandId === commandId ? { ...item, stale: false, waiting: false } : item,
          ),
        );
        if (command.queue === true && holdsQueued)
          setHanding((previous) => [...previous, { commandId, text: command.message }]);
        else {
          phoneQueuedRef.current++;
          setQueued((previous) => [
            ...previous,
            { commandId, text: command.message, uploads: command.uploadIds ?? [] },
          ]);
        }
        sendingStream.command(command, commandId);
      };
      return serialize(run);
    },
    [mutatePending, serialize, holdsQueued],
  );
  // A refused hand-over is shown as not sent, with the desktop's reason, as
  // any refused send is; nothing about it waits anywhere.
  const dismissFailed = useCallback((commandId: string) => {
    setOptimistic((previous) =>
      previous.filter(
        (item) => !(item.commandId === commandId && item.failed !== undefined),
      ),
    );
  }, []);
  const request = useCallback(
    (input: Request) =>
      new Promise<unknown>((resolve, reject) => {
        if (!stream.current) {
          reject(new Error("Conversation is not connected."));
          return;
        }
        const requestId = stream.current.request(input);
        const timer = setTimeout(() => {
          requestsRef.delete(requestId);
          reject(new Error("Request timed out. Try again."));
        }, 15_000);
        requestsRef.set(requestId, { resolve, reject, timer });
      }),
    [requestsRef],
  );
  const retry = useCallback(() => {
    setNotice("");
    stream.current?.retry();
  }, []);
  const loadEarlier = useCallback(async () => {
    if (page.beforeCursor === null) return;
    const owner = lifecycle.current;
    try {
      const result = recordValue(
        await request({
          type: "loadEarlier",
          beforeCursor: page.beforeCursor,
          turnLimit: 10,
        }),
      );
      if (owner !== lifecycle.current) return;
      const older = recordValue(result.page);
      if (result.ok === true && Array.isArray(older.events)) {
        eventsRef.current = mergeConversationEvents(
          eventsRef.current,
          older.events as ConversationEvent[],
        );
        setEvents(eventsRef.current);
        void persistLatest(held()).catch(() => {
          if (owner === lifecycle.current)
            setNotice("Conversation cache could not be saved.");
        });
        setPage({
          hasMore: older.hasMore === true,
          beforeCursor:
            typeof older.beforeCursor === "number" ? older.beforeCursor : null,
        });
      } else throw new Error("Could not load older messages.");
    } catch (error) {
      if (owner === lifecycle.current)
        setNotice(
          error instanceof Error
            ? error.message
            : "Could not load older messages.",
        );
    }
  }, [page.beforeCursor, request, persistLatest, held]);
  // Background work the desktop lists for the chat, which the transcript
  // alone may not show (a monitor that will wake the agent): working, never a
  // turn, so a send goes straight to the desktop.
  const listedBackground = !projection.turnBusy && chatWorksInBackground(effectiveThread);
  return {
    api,
    ...projection,
    /** A turn is in flight, or something works in the background. */
    busy: projection.busy || listedBackground,
    /** Nothing is in a turn, but an agent or a monitor still works. */
    inBackground: !projection.turnBusy && (projection.busy || listedBackground),
    state,
    notice,
    setNotice,
    retry,
    page,
    loadEarlier,
    request,
    command,
    setModel,
    setPermissionPreset,
    queueSend,
    queued,
    cancelQueued,
    sendNow,
    holdsQueued,
    takesSteer,
    stopsAgents,
    stopAgent,
    /** Lanes whose Stop is on its way or taken, while the agent still runs. */
    stoppingAgentIds,
    desktopHeld,
    handing,
    cancelHeld,
    dismissFailed,
    pendingActionIds,
    actionErrors,
    effectiveThread,
    listedTitle,
    optimistic: optimistic.filter(
      (item) => !projection.acknowledged.has(item.commandId),
    ),
  };
}
