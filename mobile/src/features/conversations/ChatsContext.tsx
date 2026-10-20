import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { createConversationLifecycleApi, type ConversationLifecycleApi } from "../../api/conversationLifecycle";
import { createTailnetConversationsApi, type ConversationApi } from "../../api/tailnetConversations";
import { declaresChatMarkUnread, declaresConversationLifecycle } from "../../api/tailnetTransport";
import { createTailnetWorkspacesApi, type DesktopWorkspace, type WorkspacesApi } from "../../api/tailnetWorkspaces";
import type { ApiResult, MobileSession } from "../../api/types";
import { useToast } from "../../components/Toast";
import type { DeviceNotesStore } from "../../storage/sessionStore";
import {
  beginSettle,
  confirmSettle,
  failSettle,
  listedVisitRewind,
  settlesAfterRead,
  visitRewindApplies,
  visitStampDue,
  withoutSettling,
  withVisitRewind,
  type PendingSettles,
  type VisitRewind,
  type VisitTrigger,
} from "./chatLifecycleLogic";
import {
  buildChatRows,
  canReadWorkspaces,
  canStartChats,
  chatOpenedKey,
  chatRowTitle,
  chatWorkspaceKey,
  type ChatListRow,
} from "./conversationListLogic";
import { conversationCanOperate, conversationEnabled } from "./conversationLogic";
import { keepUnchanged } from "./keepUnchanged";
import type { FollowUpBehavior } from "./followUp";
import { createRecentRead } from "./recentRead";

/** One paired desktop whose projects this phone may read. */
export interface ChatDesktop {
  deviceId: string;
  name: string;
  /** Whether New may start a chat here: it streams chats and this phone may operate them. */
  canStart: boolean;
  /** How the desktop draws itself as a machine, when its identity says; see `desktopMachineMark`. */
  machineMark: { kind: string; color: string } | null;
}

/**
 * What the chat surfaces share: the chats across every paired desktop, when
 * this phone last opened each, and the per-desktop reads New and the chat's
 * project pill need.
 *
 * The list lives here rather than on the list screen because the bell reads it
 * too: its dot and its screen are built from the same rows the list draws, so
 * the two can never disagree about what is waiting.
 *
 * It holds every paired desktop rather than only the active one: the list is
 * one flat list across machines, with the machine as a pill on the row. The
 * active desktop still decides whose SNAPSHOT the app reads; that is the data
 * provider's business, not this one's.
 */
export interface ChatsValue {
  /** Paired desktops whose projects this phone may read, the active one first. */
  desktops: ChatDesktop[];
  /** Whether New has anywhere to start a chat. */
  canStart: boolean;
  /** How many paired desktops stream chats at all; none means the list explains why rather than listing. */
  streamingDesktops: number;
  /** The workspace and CLI reads for one desktop, or null when this phone may not make them there. */
  apiFor: (deviceId: string) => WorkspacesApi | null;
  /**
   * The conversation API the provider was handed in place of each desktop's
   * own, or null (always, in the app). The screenshot harness's fake desktop
   * is one: a chat opened from its list has to read that desktop's chat, not
   * try to reach a real one.
   */
  conversationsApiOverride: ConversationApi | null;
  /**
   * One desktop's workspace list as the chat list last read it, when that
   * was in the last minute, else read now; null where it may not be read.
   */
  recentWorkspaces: (deviceId: string) => Promise<ApiResult<DesktopWorkspace[]>> | null;
  /**
   * Every desktop's chats, as listed, less any this phone is settling; the
   * list screen orders and groups them.
   */
  chats: ChatListRow[];
  /** The desktops whose list did not answer on the last read. */
  failures: string[];
  /** False until the first read has answered. */
  loaded: boolean;
  refreshing: boolean;
  /** Read every desktop's chats and workspaces afresh: start, pairings, pull to refresh. */
  refresh: () => Promise<void>;
  /**
   * Read every desktop's chats afresh, and its workspaces only when the
   * chats name one the last minute's read did not: the list coming back into
   * view.
   */
  revalidate: () => Promise<void>;
  /** When this phone last opened each chat, by `chatOpenedKey`; the other half of "finished while you were away". */
  openedAt: Record<string, number>;
  markChatOpened: (key: string) => void;
  /**
   * Settles the chat's workspace on its desktop. The row leaves the list at
   * once; a refusal brings it back and says why in a toast. Answers whether
   * the desktop settled it. Only for a row that is `settleable`.
   */
  settleChat: (row: ChatListRow) => Promise<boolean>;
  /**
   * Marks the chat unread on its desktop (`conversation.mark_unread`): its
   * visit clock goes back to just before its latest finish, on every device.
   * The row shows it the moment the desktop answers; a refusal says why in a
   * toast. Answers whether the desktop marked it. Only for a row that
   * `markUnreadOffered`. Looking at the chat is what reads it, so a chat
   * marked from its own screen is marked as the person leaves it: nothing
   * stamps it seen until it is next opened.
   */
  markUnreadChat: (row: ChatListRow) => Promise<boolean>;
  /**
   * Tells the chat's desktop the chat is on screen, when a stamp is due
   * (`visitStampDue`): `turnEndedAt` is when this phone last saw a turn end
   * in it, if it has. Silent: a stamp that fails is logged and nothing else.
   * Nothing is sent to a desktop that does not advertise `conversation-lifecycle`.
   */
  visitChat: (chat: { deviceId: string; workspaceId: string }, trigger: VisitTrigger, turnEndedAt?: number | null) => void;
  /**
   * Whether Home groups chats under their projects, as the desktop sidebar's
   * project view does, rather than listing them newest first. A setting, not
   * a control on the list: off unless turned on in Settings.
   */
  groupByProject: boolean;
  setGroupByProject: (enabled: boolean) => void;
  /**
   * What a message sent while an agent works does by default: wait for the
   * turn to end, or go into it now. A long press on the send does the other.
   */
  followUpBehavior: FollowUpBehavior;
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
}

// Exported for the screenshot harness (src/__verify__), which lays a fixture
// row over the list for one screen. Nothing in the app reads it directly.
export const ChatsContext = createContext<ChatsValue | null>(null);

const chatKey = (row: ChatListRow) => JSON.stringify([row.deviceId, row.thread.workspaceId, row.thread.agentId]);

export function ChatsProvider({
  sessions,
  activeDeviceId,
  notesStore,
  children,
  workspacesApiOverride,
  conversationsApiOverride,
  lifecycleApiOverride,
}: {
  sessions: MobileSession[];
  /** Which desktop the rest of the app is pointed at; it leads the desktop list. */
  activeDeviceId?: string | null;
  notesStore?: DeviceNotesStore | null;
  children: ReactNode;
  /** The screenshot harness supplies fake gateways; the app never passes these. */
  workspacesApiOverride?: WorkspacesApi | null;
  conversationsApiOverride?: ConversationApi | null;
  lifecycleApiOverride?: ConversationLifecycleApi | null;
}) {
  const toast = useToast();
  // Read through a ref: outside a provider the hook hands back a new object
  // every render, and the callbacks below should not churn with it.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // Workspace reads need `workspace:read` and nothing else. A pairing without
  // the chat lane still gets them, so the list can name its projects the day
  // its Studio updates.
  const workspaceClients = useMemo(() => {
    const ordered = sessions
      .filter(canReadWorkspaces)
      // The active desktop leads, so a one-desktop phone and a four-desktop
      // phone agree about which desktop an empty state names.
      .sort((a, b) => Number(b.deviceId === activeDeviceId) - Number(a.deviceId === activeDeviceId));
    return ordered.map((session) => ({
      desktop: {
        deviceId: session.deviceId,
        name: session.desktopName,
        canStart: canStartChats(session),
        machineMark: session.machineMark ?? null,
      },
      api:
        workspacesApiOverride ??
        createTailnetWorkspacesApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
    }));
  }, [activeDeviceId, sessions, workspacesApiOverride]);

  const chatClients = useMemo(
    () =>
      sessions.filter(conversationEnabled).map((session) => ({
        session,
        api:
          conversationsApiOverride ??
          createTailnetConversationsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
        // Settle and visit, only where the desktop said it takes them.
        lifecycle: declaresConversationLifecycle(session)
          ? (lifecycleApiOverride ??
            createConversationLifecycleApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }))
          : null,
        canOperate: conversationCanOperate(session),
        // Mark unread rides the lifecycle tools, where the desktop takes it too.
        markUnread: declaresConversationLifecycle(session) && declaresChatMarkUnread(session),
      })),
    [conversationsApiOverride, lifecycleApiOverride, sessions],
  );
  const lifecycleFor = useCallback(
    (deviceId: string): ConversationLifecycleApi | null =>
      chatClients.find((client) => client.session.deviceId === deviceId)?.lifecycle ?? null,
    [chatClients],
  );

  const desktops = useMemo(() => workspaceClients.map((client) => client.desktop), [workspaceClients]);
  const apiFor = useCallback(
    (deviceId: string) => workspaceClients.find((client) => client.desktop.deviceId === deviceId)?.api ?? null,
    [workspaceClients],
  );
  // Each desktop's workspace list, shared: a chat opened from the list names
  // its project from the read the list made on its way into view.
  const workspaceReads = useMemo(
    () =>
      new Map(
        workspaceClients.map((client) => [client.desktop.deviceId, createRecentRead(() => client.api.listWorkspaces())]),
      ),
    [workspaceClients],
  );
  const recentWorkspaces = useCallback(
    (deviceId: string) => workspaceReads.get(deviceId)?.recent() ?? null,
    [workspaceReads],
  );

  const [chats, setChats] = useState<ChatListRow[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  // Settles this phone has asked for and the list has not yet caught up with;
  // their rows stay hidden meanwhile (see `PendingSettles`).
  const [settles, setSettles] = useState<PendingSettles>({});
  // Marks unread this phone knows of, by `chatWorkspaceKey`: its own, and
  // those its list reads show (`listedVisitRewind`). Each wins over this
  // phone's readings of the chat from before it (`withVisitRewind`, and the
  // reset below). The latest per chat is kept for as long as the app runs.
  const [rewinds, setRewinds] = useState<Readonly<Record<string, VisitRewind>>>({});
  // Each chat's visit clock as this phone last heard it from the desktop: the
  // last list read's, and the latest visit answer's with when it came. A list
  // read that set out after either and lists an earlier clock shows a mark
  // unread made elsewhere, since nothing else moves the clock back.
  const heardVisits = useRef(new Map<string, { listed?: number; visit?: { at: number; heardAt: number } }>());
  // When this phone last stamped a visit to each chat, the throttle's clock
  // (`visitChat`). A mark unread clears it, so the next opening stamps at once.
  const visitSent = useRef(new Map<string, number>());
  const noteRewind = useCallback((key: string, rewind: VisitRewind) => {
    visitSent.current.delete(key);
    const heard = heardVisits.current.get(key);
    if (heard) heard.visit = undefined;
    setRewinds((current) =>
      current[key] && current[key].rewoundAt >= rewind.rewoundAt ? current : { ...current, [key]: rewind },
    );
  }, []);

  const readChats = useCallback(async (workspacesFrom: "fresh" | "recent") => {
    const request = ++generation.current;
    const startedAt = Date.now();
    setRefreshing(true);
    const answers = await Promise.all(
      chatClients.map(async ({ session, api, lifecycle, canOperate, markUnread }) => {
        // The project pill comes from the desktop's workspace list. A pairing
        // that may not read it omits the pill rather than showing a workspace
        // id nobody chose.
        const reads = workspaceReads.get(session.deviceId);
        let [threads, workspaces] = await Promise.all([
          api.list().catch(() => null),
          reads?.[workspacesFrom]().catch(() => null) ?? Promise.resolve(null),
        ]);
        // A workspace list kept from the last minute names every chat it knew
        // of; one opened since needs the desktop's list as it is now.
        if (
          workspacesFrom === "recent" &&
          reads &&
          workspaces?.ok &&
          threads?.some((thread) => !workspaces?.data?.some((entry) => entry.workspaceId === thread.workspaceId))
        )
          workspaces = await reads.fresh().catch(() => null);
        return {
          session,
          rows: buildChatRows({
            deviceId: session.deviceId,
            desktopName: session.desktopName,
            threads: threads ?? [],
            workspaces: workspaces?.ok ? (workspaces.data ?? []) : null,
            lifecycle: lifecycle !== null,
            canOperate,
            markUnread,
          }),
          markUnread,
          failed: threads === null,
        };
      }),
    );
    if (request !== generation.current) return;
    // A visit clock that went back since the last read, or a mark the desktop
    // lists, is a mark unread made elsewhere (`listedVisitRewind`).
    for (const answer of answers) {
      if (answer.failed) continue;
      const clocks = new Map<string, { lastVisitedAt?: number; visitRewoundAt?: number }>();
      for (const row of answer.rows) {
        const key = chatWorkspaceKey(row);
        const entry = clocks.get(key) ?? {};
        const { lastVisitedAt, visitRewoundAt } = row.thread;
        if (lastVisitedAt !== undefined) entry.lastVisitedAt = Math.max(entry.lastVisitedAt ?? lastVisitedAt, lastVisitedAt);
        if (visitRewoundAt !== undefined) entry.visitRewoundAt = Math.max(entry.visitRewoundAt ?? visitRewoundAt, visitRewoundAt);
        clocks.set(key, entry);
      }
      for (const [key, thread] of clocks) {
        const heard = heardVisits.current.get(key) ?? {};
        // A visit answered after this read set out may be later than what it lists.
        const visit = heard.visit && heard.visit.heardAt <= startedAt ? heard.visit.at : undefined;
        const previous = Math.max(heard.listed ?? -1, visit ?? -1);
        const rewind = listedVisitRewind({
          thread,
          previousVisitedAt: previous >= 0 ? previous : null,
          readStartedAt: startedAt,
          markUnread: answer.markUnread,
        });
        if (thread.lastVisitedAt !== undefined) heardVisits.current.set(key, { ...heard, listed: thread.lastVisitedAt });
        if (rewind) noteRewind(key, rewind);
      }
    }
    // Rows that read as they did stay the objects the list holds, so a read
    // that found one new chat draws one row, not every row again.
    setChats((previous) => keepUnchanged(previous, answers.flatMap((answer) => answer.rows), chatKey));
    setSettles((current) => settlesAfterRead(current, startedAt));
    setFailures(answers.filter((answer) => answer.failed).map((answer) => answer.session.desktopName));
    // An answer for no desktops is not an answer for the ones paired next:
    // the provider reads once before the stored pairings arrive, and that
    // empty answer drew "No chats yet" over a cold start's first real read.
    setLoaded(chatClients.length > 0);
    setRefreshing(false);
  }, [workspaceReads, chatClients, noteRewind]);

  // The read under way, and the pairings it is for. A refresh asked for while
  // one for the same pairings is in flight joins it: a cold start asked twice
  // in one moment (the provider for the pairings, the list screen for its
  // focus) and opened two sockets to every desktop for the same answer.
  const inFlight = useRef<{ clients: typeof chatClients; reading: Promise<void> } | null>(null);
  const read = useCallback((workspacesFrom: "fresh" | "recent") => {
    const joined = inFlight.current;
    if (joined && joined.clients === chatClients) return joined.reading;
    const reading = readChats(workspacesFrom);
    inFlight.current = { clients: chatClients, reading };
    void reading
      .finally(() => {
        if (inFlight.current?.reading === reading) inFlight.current = null;
      })
      .catch(() => undefined);
    return reading;
  }, [chatClients, readChats]);
  const refresh = useCallback(() => read("fresh"), [read]);
  const revalidate = useCallback(() => read("recent"), [read]);

  // Read on start and whenever the pairings change — a new desktop, a Studio
  // that updated and now streams chats — as well as whenever the list screen
  // comes back into view. A read already in flight for the old pairings is
  // superseded by the generation check rather than landing on the new list.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When each chat was last opened here, read back from the device notes once
  // at start. Until it has landed nothing is taken as a first sighting below:
  // doing so would stamp every chat "seen now" over what was stored, and a
  // chat that finished while the app was closed would never light up.
  const [openedAt, setOpenedAt] = useState<Record<string, number>>({});
  // Chats marked unread from here and not opened since, by `chatWorkspaceKey`,
  // with their `chatOpenedKey`s: until the next opening nothing here reads
  // them, so a mark made on the chat's own screen is not read again by the
  // person leaving it (`visitChat`, `markChatOpened`).
  const heldUnread = useRef(new Map<string, Set<string>>());
  const [openedLoaded, setOpenedLoaded] = useState(!notesStore);
  useEffect(() => {
    if (!notesStore) return;
    let live = true;
    void notesStore
      .getChatsOpened()
      .then((stored) => {
        if (!live) return;
        setOpenedAt((current) => {
          const merged = { ...stored };
          for (const [key, at] of Object.entries(current)) merged[key] = Math.max(merged[key] ?? 0, at);
          return merged;
        });
      })
      .finally(() => {
        if (live) setOpenedLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [notesStore]);

  const [groupByProject, setGroupByProjectState] = useState(false);
  useEffect(() => {
    if (!notesStore) return;
    let live = true;
    void notesStore.getGroupChatsByProject().then((enabled) => {
      if (live) setGroupByProjectState(enabled);
    });
    return () => {
      live = false;
    };
  }, [notesStore]);
  const setGroupByProject = useCallback(
    (enabled: boolean) => {
      setGroupByProjectState(enabled);
      void notesStore?.saveGroupChatsByProject(enabled);
    },
    [notesStore],
  );

  const [followUpBehavior, setFollowUpBehaviorState] = useState<FollowUpBehavior>("queue");
  useEffect(() => {
    if (!notesStore) return;
    let live = true;
    void notesStore.getFollowUpBehavior().then((behavior) => {
      if (live) setFollowUpBehaviorState(behavior);
    });
    return () => {
      live = false;
    };
  }, [notesStore]);
  const setFollowUpBehavior = useCallback(
    (behavior: FollowUpBehavior) => {
      setFollowUpBehaviorState(behavior);
      void notesStore?.saveFollowUpBehavior(behavior);
    },
    [notesStore],
  );

  const markChatOpened = useCallback(
    (key: string) => {
      for (const held of heldUnread.current.values()) if (held.has(key)) return;
      const at = Date.now();
      // State first, storage second: opening a row must clear its green
      // immediately even on a device where secure storage is unavailable.
      setOpenedAt((current) => ({ ...current, [key]: Math.max(current[key] ?? 0, at) }));
      void notesStore?.markChatOpened(key, at);
    },
    [notesStore],
  );

  const settleChat = useCallback(
    async (row: ChatListRow) => {
      const api = lifecycleFor(row.deviceId);
      if (!api || !row.settleable) return false;
      const key = chatWorkspaceKey(row);
      setSettles((current) => beginSettle(current, key));
      const result = await api.settle(row.thread.workspaceId).catch(() => null);
      if (result?.ok) {
        setSettles((current) => confirmSettle(current, key, Date.now()));
        void refresh();
        return true;
      }
      setSettles((current) => failSettle(current, key));
      toastRef.current.show({
        title: `Couldn't settle “${chatRowTitle(row).title}”.`,
        message: result?.message ?? "The desktop did not answer.",
        tone: "error",
      });
      return false;
    },
    [lifecycleFor, refresh],
  );

  // The desktop's visit clock each visit this phone stamped answered with, by
  // `chatWorkspaceKey`, which the list reads until its next read carries the
  // same (when each was sent is `visitSent`, above).
  const [visited, setVisited] = useState<Record<string, number>>({});
  const visitedRef = useRef(visited);
  visitedRef.current = visited;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const markUnreadChat = useCallback(
    async (row: ChatListRow) => {
      const client = chatClients.find((entry) => entry.session.deviceId === row.deviceId);
      const api = client?.markUnread ? client.lifecycle : null;
      if (!api || !row.canMarkUnread) return false;
      const key = chatWorkspaceKey(row);
      // Held from the moment it is asked for: the person leaving the chat's
      // screen, which comes before the answer, must not read it again.
      const openedKeys = new Set([chatOpenedKey(row.deviceId, row.thread.agentId)]);
      for (const listed of chatsRef.current)
        if (chatWorkspaceKey(listed) === key) openedKeys.add(chatOpenedKey(listed.deviceId, listed.thread.agentId));
      heldUnread.current.set(key, openedKeys);
      const result = await api.markUnread(row.thread.workspaceId).catch(() => null);
      if (result?.ok && result.data) {
        const visitedAt = result.data.lastVisitedAt;
        noteRewind(key, { visitedAt, rewoundAt: Date.now() });
        // The next read lists this clock; it is this phone's own mark, not news.
        heardVisits.current.set(key, { listed: visitedAt });
        void refresh();
        return true;
      }
      if (heldUnread.current.get(key) === openedKeys) heldUnread.current.delete(key);
      toastRef.current.show({
        title: `Couldn't mark “${chatRowTitle(row).title}” unread.`,
        message: result?.message ?? "The desktop did not answer.",
        tone: "error",
      });
      return false;
    },
    [chatClients, noteRewind, refresh],
  );
  const visitChat = useCallback(
    (chat: { deviceId: string; workspaceId: string }, trigger: VisitTrigger, turnEndedAt: number | null = null) => {
      const key = chatWorkspaceKey({ deviceId: chat.deviceId, thread: { workspaceId: chat.workspaceId } });
      // A chat marked unread is read again only by opening it.
      if (heldUnread.current.has(key)) {
        if (trigger !== "open") return;
        heldUnread.current.delete(key);
      }
      const api = lifecycleFor(chat.deviceId);
      if (!api) return;
      const now = Date.now();
      // A visit is to the workspace, so every chat listed in it speaks for it.
      // The desktop's answers count too: they are on its clock, as its turn
      // ends are, which this phone's own stamps are not.
      let visitedAt: number | null = visitedRef.current[key] ?? null;
      let ended = turnEndedAt;
      for (const row of chatsRef.current) {
        if (chatWorkspaceKey(row) !== key) continue;
        const { lastVisitedAt, lastTurnEndedAt } = row.thread;
        if (lastVisitedAt !== undefined) visitedAt = Math.max(visitedAt ?? 0, lastVisitedAt);
        if (lastTurnEndedAt !== undefined) ended = Math.max(ended ?? 0, lastTurnEndedAt);
      }
      const due = visitStampDue({
        trigger,
        now,
        lastSentAt: visitSent.current.get(key) ?? null,
        visitedAt,
        turnEndedAt: ended,
      });
      if (!due) return;
      visitSent.current.set(key, now);
      void api
        .visit(chat.workspaceId)
        .then((result) => {
          if (result.ok && result.data) {
            const at = result.data.lastVisitedAt;
            const heard = heardVisits.current.get(key) ?? {};
            if (!heard.visit || heard.visit.at < at) heardVisits.current.set(key, { ...heard, visit: { at, heardAt: Date.now() } });
            setVisited((current) => (current[key] !== undefined && current[key] >= at ? current : { ...current, [key]: at }));
          } else {
            console.warn(`conversation.visit failed: ${result.message ?? result.errorCode ?? "unknown"}`);
          }
        })
        .catch((error: unknown) => {
          console.warn("conversation.visit failed", error);
        });
    },
    [lifecycleFor],
  );

  // The list as drawn: a mark unread wins over every reading from before it,
  // a visit the desktop just confirmed counts at once, and a chat being
  // settled is already gone.
  const listedChats = useMemo(() => {
    const drawn =
      Object.keys(visited).length || Object.keys(rewinds).length
        ? chats.map((row) => {
            const key = chatWorkspaceKey(row);
            const rewind = rewinds[key];
            let thread = withVisitRewind(row.thread, rewind);
            const at = visited[key];
            if (at !== undefined && at > (thread.lastVisitedAt ?? 0) && !(rewind && visitRewindApplies(rewind, at)))
              thread = { ...thread, lastVisitedAt: at };
            return thread === row.thread ? row : { ...row, thread };
          })
        : chats;
    return withoutSettling(drawn, settles);
  }, [chats, rewinds, settles, visited]);

  // A mark unread resets this phone's own readings of the chat from before
  // it to the desktop's rewound clock: a visit answer it holds, and when it
  // last opened the chat, in the device notes too, so the mark is still up
  // after a restart. A reading taken since the mark stands. Not before the
  // notes have loaded, whose later stamps would otherwise be merged back over.
  useEffect(() => {
    if (!openedLoaded || !Object.keys(rewinds).length) return;
    const lowered: Record<string, number> = {};
    const dropped: string[] = [];
    for (const [key, rewind] of Object.entries(rewinds)) {
      if (visitRewindApplies(rewind, visited[key])) dropped.push(key);
      for (const row of chats) {
        if (chatWorkspaceKey(row) !== key) continue;
        const opened = chatOpenedKey(row.deviceId, row.thread.agentId);
        if (visitRewindApplies(rewind, openedAt[opened])) lowered[opened] = rewind.visitedAt;
      }
    }
    if (dropped.length)
      setVisited((current) => {
        const next = { ...current };
        for (const key of dropped) delete next[key];
        return next;
      });
    if (Object.keys(lowered).length) {
      setOpenedAt((current) => ({ ...current, ...lowered }));
      for (const [opened, at] of Object.entries(lowered)) void notesStore?.rewindChatOpened(opened, at);
    }
  }, [chats, notesStore, openedAt, openedLoaded, rewinds, visited]);

  // A chat this phone has never seen starts from here: its first sighting is
  // its baseline, so only a turn that ends while the phone is paired lights
  // green. Without it a fresh pairing washed every chat from the last day.
  useEffect(() => {
    if (!openedLoaded) return;
    for (const row of chats) {
      const key = chatOpenedKey(row.deviceId, row.thread.agentId);
      if (openedAt[key] === undefined) markChatOpened(key);
    }
  }, [chats, markChatOpened, openedAt, openedLoaded]);

  const value = useMemo<ChatsValue>(
    () => ({
      desktops,
      canStart: desktops.some((desktop) => desktop.canStart),
      streamingDesktops: chatClients.length,
      apiFor,
      conversationsApiOverride: conversationsApiOverride ?? null,
      recentWorkspaces,
      chats: listedChats,
      failures,
      loaded,
      refreshing,
      refresh,
      revalidate,
      openedAt,
      markChatOpened,
      settleChat,
      markUnreadChat,
      visitChat,
      groupByProject,
      setGroupByProject,
      followUpBehavior,
      setFollowUpBehavior,
    }),
    [
      apiFor,
      conversationsApiOverride,
      chatClients.length,
      desktops,
      failures,
      listedChats,
      loaded,
      markChatOpened,
      openedAt,
      recentWorkspaces,
      refresh,
      refreshing,
      revalidate,
      settleChat,
      markUnreadChat,
      visitChat,
      groupByProject,
      setGroupByProject,
      followUpBehavior,
      setFollowUpBehavior,
    ],
  );

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}

export function useChats(): ChatsValue {
  const value = useContext(ChatsContext);
  if (!value) {
    throw new Error("useChats must be called inside a ChatsProvider.");
  }
  return value;
}
