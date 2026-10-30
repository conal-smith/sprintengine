import * as LegacyFileSystem from "expo-file-system/legacy";

import {
  CONVERSATION_RESYNC_CLOSE_CODE,
  CONVERSATION_SCOPE_CLOSE_CODE,
  conversationCloseRetryAfterMs,
  conversationSendProblem,
  conversationSessionWasLost,
  conversationSocketUrl,
  createConversationChunkAssembler,
  createSnapshotAssembler,
  heldSendLanded,
  parseConversationFrame,
  type ConversationClientFrame,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationKey,
  type ConversationServerFrame,
  type ConversationThread,
} from "./conversationWire";
import { readPeerRefusal, type TailnetPeerRefusal } from "./tailnetTransport";
import { queuedSendStale, turnEndedSince } from "../features/conversations/queuedSends";
import {
  conversationImageSource,
  conversationFileUploadRefusal,
  conversationUploadRefusal,
  readConversationImageProblem,
  type ConversationImageProblem,
  type ConversationImageRef,
  type ConversationImageSource,
} from "./conversationImages";

const TICKET_PATH = "/tailnet/v1/ws-ticket";
const UPLOAD_PATH = "/tailnet/v1/upload";
const TICKET_TIMEOUT_MS = 10_000;
/**
 * How long a probe waits for the socket to say anything. Ten seconds, not
 * three: on a poor link (one bar of cellular, a congested tailnet relay) a
 * frame can take several seconds to cross, and a busy desktop can be slow to
 * answer even a small question. Three seconds tore down sockets that were
 * only slow, and every redial cost a fresh ticket and a replay.
 */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * How many probes in a row may go unanswered before the socket is taken for
 * dead. One lost probe on a lossy link is not a dead socket; two in a row,
 * with nothing else heard for the whole time, is.
 */
const PROBE_MISSES_ALLOWED = 1;
/**
 * How long a synchronized socket may stay silent before it is asked whether
 * it is still there. A socket can die without closing (Wi-Fi handed to
 * cellular, the tailnet re-keying), and until TCP gave up the chat read
 * "live" while nothing could reach it. A silent window sends the foreground's
 * own probe; probes that go unanswered redial. Fifteen seconds is long enough
 * that a quiet turn (a model thinking, a long command) is not mistaken for a
 * dead link, and short enough that a person waiting on a reply notices the
 * redial rather than the silence. A chat's socket carries the stream itself,
 * so only silence is asked about: a busy socket is a live one, and any frame
 * that arrives while a probe waits answers it.
 */
const IDLE_PROBE_MS = 15_000;
const REVOKED_CLOSE_CODE = 4401;
const POLICY_CLOSE_CODE = 1008;
const REVOKED_MESSAGE = "Pairing was revoked.";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const BUSY_RETRY_MS = 1_000;
/** Away for this long, the app back in front redials rather than probes the socket it left. */
const FOREGROUND_REDIAL_MS = 10_000;
const TURN_ENDS = ["turn_completed", "turn_failed", "session_stopped", "session_closed"];

/**
 * How long to wait before reconnect attempt `attempt` (0-based): exponential
 * from one second to a thirty-second cap, with the upper half jittered so a
 * desktop that restarts is not met by every phone at the same instant, and
 * never sooner than the desktop asked. The attempt count only resets once a
 * subscription reaches `synchronized`, so a socket that opens and is closed
 * again straight away still backs off.
 */
export function conversationReconnectDelay(
  attempt: number,
  advisedMs?: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 5),
  );
  const backoff = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.max(advisedMs ?? 0, backoff));
}

type NativeSocket = new (
  url: string,
  protocols: string | string[] | undefined,
  options: { headers: Record<string, string> },
) => WebSocket;
const openSocket = (url: string): WebSocket =>
  new (WebSocket as unknown as NativeSocket)(url, undefined, {
    headers: { origin: "" },
  });

/**
 * A ticket refused over the tailnet node that asked for it rather than the
 * token: the desktop could not place this phone through Tailscale for a
 * moment, or knows this pairing from another node. Neither is a revocation.
 */
class PeerRefusedError extends Error {
  readonly refusal: TailnetPeerRefusal;
  constructor(refusal: TailnetPeerRefusal) {
    super(refusal.message);
    this.name = "PeerRefusedError";
    this.refusal = refusal;
  }
}

async function mintTicket(
  baseUrl: string,
  deviceToken: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${TICKET_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) {
        // A token held to another node, or one whois could not place, is
        // still a pairing: only a token the desktop no longer knows is revoked.
        const refusal = readPeerRefusal(
          401,
          await response.json().catch(() => null),
        );
        throw refusal ? new PeerRefusedError(refusal) : new Error(REVOKED_MESSAGE);
      }
      throw new Error(`Ticket refused (${response.status}).`);
    }
    const body = (await response.json()) as { ticket?: unknown };
    if (typeof body.ticket !== "string")
      throw new Error("Desktop did not return a socket ticket.");
    return body.ticket;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `blocked`: the device may no longer read this conversation (its grant lost
 * `conversation:read`), so the stream stopped. `revoked`: the desktop revoked
 * this phone; only pairing again helps. Neither retries. `unavailable`: the
 * desktop refused the subscription and said retrying will not help (the
 * conversation is gone, say); the stream waits for `retry()`.
 */
export type ConversationConnectionState =
  | "connecting"
  | "synchronizing"
  | "live"
  | "offline"
  | "unavailable"
  | "blocked"
  | "revoked";
export interface ConversationStreamHandlers {
  onState(state: ConversationConnectionState, detail?: string): void;
  onFrame(frame: ConversationServerFrame): void;
  onSendStarted?(commandId: string): void;
  /**
   * The desktop turned a send away because a turn is running there: it stays
   * here under its id and goes when the turn ends.
   */
  onSendWaiting?(commandId: string): void;
  /**
   * A send the desktop turned away busy was offered to it again, under the
   * same id, to hold until the turn ends (`conversation-queued-sends`):
   * `command` is the send as it is now offered, and `heldAfter` the cursor
   * no offer of it precedes, for the cache to keep.
   */
  onSendHeld?(
    commandId: string,
    command: Extract<ConversationCommand, { kind: "send" }>,
    heldAfter: number,
  ): void;
  /**
   * A send this stream no longer offers without asking: it waited across an
   * absence too long, or its turn ended meanwhile, or the desktop refused it
   * `stale`. It waits for the person's Send now (the same command with
   * `confirmedStale`, under its id) or Discard (`cancelPending`).
   */
  onSendStale?(commandId: string): void;
}
export interface ConversationStream {
  command(command: ConversationCommand, commandId?: string): string;
  /** Stop offering a send: one waiting here, one not yet offered to be held, or one no longer sent without asking. */
  cancelPending(commandId: string): void;
  request(
    frame: Omit<
      Extract<ConversationClientFrame, { requestId: string }>,
      "requestId"
    >,
  ): string;
  foreground(backgroundMs: number): void;
  /** Dial again now, after the desktop refused the subscription outright. */
  retry(): void;
  close(): void;
}
export interface ConversationApi {
  list(): Promise<ConversationThread[]>;
  open(
    key: ConversationKey,
    afterSeq: number,
    handlers: ConversationStreamHandlers,
    options?: {
      /**
       * Sends carried over from the cache, which waited while no stream
       * offered them: each is offered only while `queuedSendStale` allows,
       * and is otherwise handed back through `onSendStale`.
       */
      pendingSends?: Array<{
        commandId: string;
        command: Extract<ConversationCommand, { kind: "send" }>;
        /** A held send's cursor when it was queued (`CachedConversation`). */
        heldAfter?: number;
        /** When it was written (`CachedConversation`). */
        queuedAt?: number;
        /** Already no longer sent without asking. */
        stale?: true;
      }>;
      initiallyBusy?: boolean;
      /**
       * The log generation `afterSeq` belongs to, from a cached snapshot or
       * fence. With it the desktop can send only the missed events; without
       * it, or when the log has moved on, it sends a reset snapshot.
       */
      generation?: string;
      /**
       * The desktop advertises `conversation-hello`: a probe asks with
       * `hello`, which it answers from what it already knows. Without it the
       * probe is a `list`, which every desktop answers but which rebuilds the
       * whole chat list, slow on a busy desktop.
       */
      hello?: boolean;
      /**
       * The desktop advertises `conversation-queued-sends`: a send that says
       * `queue` goes to it at once, whether or not a turn runs, and the
       * stream asks it to say what it holds (`watchQueued`) after every fence.
       * Without it a `queue` send is an ordinary one, held here until the turn
       * ends, so a cached one from a desktop that has since lost the
       * capability still goes.
       */
      queuedSends?: boolean;
      /**
       * The desktop advertises `conversation-queued-attachments` as well: a
       * `queue` send may carry `uploadIds`, which it makes its own the moment
       * it holds the message. Without it a `queue` send with any is an
       * ordinary one, held here until the turn ends.
       */
      queuedAttachments?: boolean;
      /**
       * The desktop advertises `conversation-scheduled-sends`: the stream
       * asks it to say what it keeps scheduled into the chat
       * (`watchScheduled`) after every fence.
       */
      scheduledSends?: boolean;
    },
  ): ConversationStream;
  uploadImage(input: {
    sessionId: string;
    uri: string;
    name: string;
    mediaType: string;
  }): Promise<string>;
  /**
   * A file of any type for the chat's next message, where the desktop
   * declares `conversation-message-files` (`kind=file`, up to 25 MB): the
   * send names the id this answers beside any photo's, and the desktop
   * attaches the file to the message by its path there.
   */
  uploadFile(input: {
    sessionId: string;
    uri: string;
    name: string;
    mediaType: string;
  }): Promise<string>;
  /**
   * Where one tool call's picture is served, as an `<Image>` source carrying
   * this phone's token. Only asked for when the desktop declares
   * `conversation-images`.
   */
  imageSource(ref: ConversationImageRef): ConversationImageSource;
  /** Why that picture did not load, asked of the desktop once. */
  imageProblem(ref: ConversationImageRef): Promise<ConversationImageProblem>;
}

function identifier(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export function createTailnetConversationsApi(input: {
  baseUrl: string;
  deviceToken: string;
  /** The wall clock a waiting send's age is read against. */
  now?: () => number;
}): ConversationApi {
  const now = input.now ?? Date.now;
  return {
    async list() {
      const ticket = await mintTicket(input.baseUrl, input.deviceToken);
      return new Promise<ConversationThread[]>((resolve, reject) => {
        const socket = openSocket(conversationSocketUrl(input.baseUrl, ticket));
        const requestId = identifier();
        const chunks = createConversationChunkAssembler();
        let settled = false;
        const timer = setTimeout(
          () => done(new Error("Conversation list timed out.")),
          10_000,
        );
        const done = (value: ConversationThread[] | Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        socket.onopen = () =>
          socket.send(JSON.stringify({ type: "list", requestId }));
        socket.onerror = () =>
          done(new Error("Conversation list is unavailable."));
        socket.onclose = () =>
          done(new Error("Conversation list connection closed."));
        socket.onmessage = (event) => {
          const parsed =
            typeof event.data === "string"
              ? parseConversationFrame(event.data)
              : null;
          const frame = parsed ? chunks.push(parsed) : null;
          if (frame?.type === "sessions" && frame.requestId === requestId)
            done(frame.sessions);
          if (frame?.type === "error") done(new Error(frame.message));
        };
      });
    },
    open(key, initialSeq, handlers, options) {
      let socket: WebSocket | null = null;
      let closed = false;
      let afterSeq = initialSeq;
      let logGeneration = options?.generation;
      let attempt = 0;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      // The desktop's own retry delay from the latest refusal on this socket,
      // applied to the reconnect that follows its close.
      let advisedRetryMs: number | undefined;
      // A reconnect the desktop asked to be delayed; foregrounding the app
      // must not cut it short.
      let heldByDesktop = false;
      // The desktop refused the subscription and retrying cannot help, so
      // nothing redials until the person asks to.
      let halted = false;
      let sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      let probeRequestId: string | null = null;
      // Probes in a row that nothing at all answered.
      let probeMisses = 0;
      const probeWithHello = options?.hello === true;
      // Whether a frame came in this idle window, and the window's timer.
      let heard = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const queuedSends = options?.queuedSends === true;
      const queuedAttachments = queuedSends && options?.queuedAttachments === true;
      // Whether the desktop can hold this send for its turn's end: one with
      // pictures or files only where it holds those too.
      const holdable = (command: Extract<ConversationCommand, { kind: "send" }>) =>
        queuedSends && (!command.uploadIds?.length || queuedAttachments);
      const scheduledSends = options?.scheduledSends === true;
      // Sends this phone holds until the turn ends, in the order written.
      const outbox = new Map<
        string,
        Extract<ConversationCommand, { kind: "send" }>
      >();
      // Sends handed to the desktop to hold (`queue`), until it answers. They
      // go at once, turn or no turn, and again under the same id after a
      // redial, which the desktop holds once. `sentAfter` is a cursor no offer
      // of it precedes (`heldSendLanded`): where this stream first offered it,
      // or, for one taken over from the cache, where it was queued, else where
      // this stream starts reading. A send the cache carries over from an
      // earlier stream may have been held and sent by the desktop while no
      // stream listened, and only the chat after that point can say so.
      // `socket` is the dial it was last offered on, so a new socket offers it
      // again.
      const held = new Map<
        string,
        {
          command: Extract<ConversationCommand, { kind: "send" }>;
          sentAfter: number | null;
          socket: number;
        }
      >();
      // Sends no longer offered without asking (`onSendStale`), until the
      // person sends one again or lets it go. `sentAfter` is a held one's, so
      // the chat can still show the desktop had it and sent it.
      const parked = new Map<
        string,
        { command: Extract<ConversationCommand, { kind: "send" }>; sentAfter: number | null }
      >();
      // When each waiting send was written, and which of them waited while
      // this phone was away (taken over from the cache, or waiting when the
      // app came back to the front): those are offered only while
      // `queuedSendStale` allows and their turn has not ended meanwhile.
      const written = new Map<string, number | undefined>();
      const away = new Set<string>();
      // Sends already offered again to be held after a busy refusal: once.
      const reheld = new Set<string>();
      const take = (
        commandId: string,
        command: Extract<ConversationCommand, { kind: "send" }>,
        sentAfter: number | null = null,
        queuedAt: number | undefined = command.composedAt,
      ) => {
        parked.delete(commandId);
        written.set(commandId, queuedAt);
        if (command.queue && holdable(command))
          held.set(commandId, { command, sentAfter, socket: -1 });
        else {
          const { queue: _queue, ...plain } = command;
          outbox.set(commandId, plain);
        }
      };
      // Taken over from the cache: what waited too long, or was found stale
      // before, is never offered; the rest is offered once the replay has
      // said whether its turn ended meanwhile.
      const staleAtOpen: string[] = [];
      for (const item of options?.pendingSends ?? []) {
        const queuedAt = item.queuedAt ?? item.command.composedAt;
        if (queuedSendStale({ queuedAt, stale: item.stale, command: item.command }, now())) {
          written.set(item.commandId, queuedAt);
          parked.set(item.commandId, {
            command: item.command,
            sentAfter: item.command.queue ? (item.heldAfter ?? initialSeq) : null,
          });
          staleAtOpen.push(item.commandId);
          continue;
        }
        take(item.commandId, item.command, item.heldAfter ?? initialSeq, queuedAt);
        away.add(item.commandId);
      }
      let heldRetryTimer: ReturnType<typeof setTimeout> | null = null;
      // Sends already offered a second time after the desktop lost the
      // session they went to. Kept for the stream's life: a send is resent
      // once, never twice.
      const resentAfterLostSession = new Set<string>();
      let synchronized = false;
      let busy = options?.initiallyBusy ?? false;
      let activeSendId: string | null = null;
      let dialGeneration = 0;
      const chunks = createConversationChunkAssembler();
      const snapshots = createSnapshotAssembler();
      const send = (frame: ConversationClientFrame) => {
        if (closed || socket?.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(frame));
        return true;
      };
      // Stop offering a waiting send; the person decides. A held one keeps its
      // cursor, so the chat can still show the desktop sent it after all.
      const park = (commandId: string): boolean => {
        const plain = outbox.get(commandId);
        const handed = held.get(commandId);
        const command = plain ?? handed?.command;
        if (!command) return false;
        outbox.delete(commandId);
        held.delete(commandId);
        away.delete(commandId);
        parked.set(commandId, { command, sentAfter: handed?.sentAfter ?? null });
        if (activeSendId === commandId) activeSendId = null;
        handlers.onSendStale?.(commandId);
        return true;
      };
      // Whether a waiting send was carried across an absence and may no
      // longer go without asking: too old now, or (`endedAt`, a turn's end on
      // the desktop's clock) its turn ended while the phone was not there.
      const staleAfterAbsence = (commandId: string, endedAt?: number) => {
        if (!away.has(commandId)) return false;
        const command = outbox.get(commandId) ?? held.get(commandId)?.command;
        if (!command || command.confirmedStale === true) return false;
        const queuedAt = written.get(commandId);
        return (
          queuedSendStale({ queuedAt, command }, now()) ||
          (endedAt !== undefined && turnEndedSince({ queuedAt }, endedAt))
        );
      };
      // Events the desktop sends before its fence are what happened while
      // this phone was not listening. A turn that ended among them was one a
      // carried send waited on, and that send's moment has passed.
      const parkAfterReplayedEnds = (events: readonly ConversationEvent[]) => {
        if (synchronized || !away.size) return;
        for (const event of events) {
          if (!TURN_ENDS.includes(event.type)) continue;
          for (const commandId of [...away])
            if (staleAfterAbsence(commandId, event.createdAt)) park(commandId);
        }
      };
      const detach = () => {
        dialGeneration++;
        synchronized = false;
        activeSendId = null;
        chunks.reset();
        snapshots.reset();
        if (sendRetryTimer) clearTimeout(sendRetryTimer);
        sendRetryTimer = null;
        if (heldRetryTimer) clearTimeout(heldRetryTimer);
        heldRetryTimer = null;
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
        probeRequestId = null;
        probeMisses = 0;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        const previous = socket;
        socket = null;
        previous?.close();
      };
      const flushSend = () => {
        if (
          !synchronized ||
          busy ||
          activeSendId ||
          sendRetryTimer ||
          socket?.readyState !== WebSocket.OPEN
        )
          return;
        for (const [commandId, command] of outbox) {
          // A send queued before the limits were checked (an older cache)
          // would be refused on every reconnect. Settle it here instead, the
          // way the desktop would, and move on to the next one.
          const problem = conversationSendProblem(commandId, command);
          if (problem) {
            outbox.delete(commandId);
            handlers.onFrame({
              type: "commandResult",
              commandId,
              ok: false,
              code: "too_large",
              message: problem,
            });
            continue;
          }
          activeSendId = commandId;
          send({ type: "command", commandId, command });
          handlers.onSendStarted?.(commandId);
          return;
        }
      };
      // Offers the desktop every held send this socket has not offered yet.
      const flushHeld = () => {
        if (!synchronized || heldRetryTimer || socket?.readyState !== WebSocket.OPEN)
          return;
        for (const [commandId, entry] of held) {
          if (entry.socket === dialGeneration) continue;
          const problem = conversationSendProblem(commandId, entry.command);
          if (problem) {
            held.delete(commandId);
            handlers.onFrame({
              type: "commandResult",
              commandId,
              ok: false,
              code: "too_large",
              message: problem,
            });
            continue;
          }
          if (!send({ type: "command", commandId, command: entry.command })) return;
          entry.sentAfter ??= afterSeq;
          entry.socket = dialGeneration;
        }
      };
      // A held send whose answer was lost, found already in the chat: it is
      // settled as accepted and never offered again. Only the first person's
      // message after the offer can be it: the desktop sends what it holds as
      // the turn it waited on ends, before anything sent after, and a send
      // made meanwhile is refused as busy or joined into the held one. A first
      // message that is not it means the desktop never held it, and no later
      // message is read as it, so a "yes" typed elsewhere afterwards is not
      // taken for a "yes" the desktop never got.
      // A held send parked as stale is read the same way: the desktop may
      // have held it before the answer was lost, and sent it since.
      const settleLandedHeld = (events: readonly ConversationEvent[]) => {
        const landed: string[] = [];
        for (const event of events) {
          if (event.type !== "user_message" || event.seq === undefined) continue;
          for (const waiting of [held, parked]) {
            for (const [commandId, entry] of waiting) {
              if (!entry.command.queue || entry.sentAfter === null || event.seq <= entry.sentAfter) continue;
              if (heldSendLanded(event, entry.command.message, entry.sentAfter)) {
                waiting.delete(commandId);
                landed.push(commandId);
              } else entry.sentAfter = Number.MAX_SAFE_INTEGER;
            }
          }
        }
        return landed;
      };
      // Asks the desktop something small; any frame back, the answer or
      // not, says the socket is there. A probe nothing answers in time is
      // asked once more, and a second silence is taken for a dead socket and
      // redialled at once.
      const probe = () => {
        const requestId = identifier();
        probeRequestId = requestId;
        send(
          probeWithHello
            ? { type: "hello", requestId }
            : { type: "list", requestId },
        );
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(() => {
          probeTimer = null;
          if (closed) return;
          if (probeMisses < PROBE_MISSES_ALLOWED) {
            probeMisses++;
            probe();
            return;
          }
          detach();
          handlers.onState("connecting");
          reconnect(undefined, true);
        }, PROBE_TIMEOUT_MS);
      };
      // Anything the socket says is proof it is there.
      const heardFrom = () => {
        heard = true;
        probeMisses = 0;
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
      };
      // A window with no frame in it probes; any frame keeps the socket
      // unasked. Timers do not run while the app is suspended, so a chat in
      // the background asks nothing.
      const watchIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        heard = false;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (closed || !synchronized) return;
          if (!heard && !probeTimer) probe();
          watchIdle();
        }, IDLE_PROBE_MS);
      };
      const reconnect = (advisedMs?: number, immediate = false) => {
        if (closed) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        advisedRetryMs = undefined;
        heldByDesktop = !immediate && (advisedMs ?? 0) > 0;
        const wait = immediate
          ? 0
          : conversationReconnectDelay(attempt++, advisedMs);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          heldByDesktop = false;
          void dial();
        }, wait);
      };
      const stop = (
        state: Extract<ConversationConnectionState, "blocked" | "revoked">,
        detail: string,
      ) => {
        closed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        detach();
        handlers.onState(state, detail);
      };
      const dial = async () => {
        if (closed) return;
        const dialing = ++dialGeneration;
        synchronized = false;
        activeSendId = null;
        chunks.reset();
        snapshots.reset();
        handlers.onState("connecting");
        try {
          const ticket = await mintTicket(input.baseUrl, input.deviceToken);
          if (closed || dialing !== dialGeneration) return;
          const next = openSocket(conversationSocketUrl(input.baseUrl, ticket));
          socket = next;
          next.onopen = () => {
            if (closed || socket !== next || dialing !== dialGeneration) return;
            handlers.onState("synchronizing");
            send({
              type: "subscribe",
              key,
              afterSeq,
              ...(logGeneration === undefined
                ? {}
                : { generation: logGeneration }),
              turnLimit: 10,
            });
          };
          next.onmessage = (message) => {
            if (closed || socket !== next || dialing !== dialGeneration) return;
            heardFrom();
            const parsed =
              typeof message.data === "string"
                ? parseConversationFrame(message.data)
                : null;
            const unassembled = parsed ? chunks.push(parsed) : null;
            if (!unassembled) return;
            // A replay or fence for another conversation must never move this
            // one's cursor.
            if (
              (unassembled.type === "snapshot" ||
                unassembled.type === "synchronized" ||
                unassembled.type === "queued" ||
                unassembled.type === "scheduled") &&
              unassembled.key &&
              (unassembled.key.workspaceId !== key.workspaceId ||
                unassembled.key.agentId !== key.agentId)
            )
              return;
            let frame: ConversationServerFrame = unassembled;
            if (unassembled.type === "snapshot") {
              const assembled = snapshots.push(unassembled);
              if ("waiting" in assembled) return;
              if ("broken" in assembled) {
                // Part of the replay went missing, so the fence after it
                // would vouch for events this phone never saw. Subscribe
                // again rather than apply a partial transcript.
                detach();
                handlers.onState("offline", "Reloading the conversation…");
                reconnect();
                return;
              }
              // A snapshot from another log generation replaces everything
              // held, whatever its reset flag says.
              const replaces =
                assembled.snapshot.reset === true ||
                (logGeneration !== undefined &&
                  assembled.snapshot.generation !== logGeneration);
              frame = replaces
                ? { ...assembled.snapshot, reset: true }
                : assembled.snapshot;
              if (replaces) logGeneration = assembled.snapshot.generation;
            }
            if (frame.type === "snapshot" && frame.reset) {
              afterSeq = frame.page.events.reduce(
                (last, event) => Math.max(last, event.seq ?? 0),
                0,
              );
              busy = false;
              for (const event of frame.page.events) {
                if (
                  event.type === "user_message" ||
                  event.type === "turn_started"
                )
                  busy = true;
                if (
                  [
                    "turn_completed",
                    "turn_failed",
                    "session_stopped",
                    "session_closed",
                  ].includes(event.type)
                )
                  busy = false;
              }
            }
            // Held sends found in the chat already, settled once the frame
            // that showed them has been handed on.
            let landed: string[] = [];
            if (frame.type === "snapshot") {
              landed = settleLandedHeld(frame.page.events);
              for (const event of frame.page.events) {
                const commandId =
                  event.type === "user_message"
                    ? event.payload?.commandId
                    : undefined;
                if (typeof commandId === "string") {
                  outbox.delete(commandId);
                  parked.delete(commandId);
                }
              }
              if (activeSendId && !outbox.has(activeSendId) && !busy)
                activeSendId = null;
            }
            if (frame.type === "event") {
              landed = settleLandedHeld([frame.event]);
              afterSeq = Math.max(afterSeq, frame.event.seq ?? 0);
              const commandId = frame.event.payload?.commandId;
              if (frame.event.type === "user_message") {
                busy = true;
                if (typeof commandId === "string") {
                  outbox.delete(commandId);
                  parked.delete(commandId);
                }
              }
              if (frame.event.type === "turn_started") busy = true;
              if (
                [
                  "turn_completed",
                  "turn_failed",
                  "session_stopped",
                  "session_closed",
                ].includes(frame.event.type)
              ) {
                busy = false;
                activeSendId = null;
                flushSend();
              }
            }
            // After the frame's own messages are read: a carried send the
            // replay shows already in the chat went, and is not parked.
            if (frame.type === "snapshot") parkAfterReplayedEnds(frame.page.events);
            if (frame.type === "event") parkAfterReplayedEnds([frame.event]);
            if (frame.type === "synchronized") {
              afterSeq = frame.seq;
              if (frame.generation !== undefined)
                logGeneration = frame.generation;
              // Carried across an absence and grown too old meanwhile: not
              // offered. The ones left go as any waiting send does, the phone
              // being here again to see them go.
              for (const commandId of [...away])
                if (staleAfterAbsence(commandId)) park(commandId);
              away.clear();
              synchronized = true;
              attempt = 0;
              watchIdle();
              handlers.onState("live");
              flushSend();
              flushHeld();
              // A watch lasts as long as the subscription it was asked on, so
              // it is asked again after every fence, a redial's included: the
              // desktop answers with what it holds now, whatever changed while
              // this phone was away.
              if (queuedSends)
                send({ type: "watchQueued", requestId: identifier() });
              if (scheduledSends)
                send({ type: "watchScheduled", requestId: identifier() });
            }
            if (
              frame.type === "commandResult" &&
              !frame.ok &&
              frame.code === "stale" &&
              (outbox.has(frame.commandId) || held.has(frame.commandId))
            ) {
              // The desktop's own limit (its clock, or a send this phone kept
              // too long): handed to the person, as one parked here is.
              park(frame.commandId);
              flushSend();
              return;
            }
            if (frame.type === "commandResult" && held.has(frame.commandId)) {
              if (!frame.ok && frame.code === "busy") {
                // Too many commands in flight from this socket: offered again
                // under the same id after the delay the desktop asked for.
                held.get(frame.commandId)!.socket = -1;
                if (heldRetryTimer) clearTimeout(heldRetryTimer);
                heldRetryTimer = setTimeout(() => {
                  heldRetryTimer = null;
                  flushHeld();
                }, frame.retryAfterMs ?? BUSY_RETRY_MS);
                return;
              }
              held.delete(frame.commandId);
            }
            if (
              frame.type === "commandResult" &&
              outbox.has(frame.commandId) &&
              !frame.ok &&
              frame.code === "busy"
            ) {
              // A turn is running there that this phone had not heard of. A
              // desktop that holds messages takes this one to send when the
              // turn ends, so it no longer depends on this phone staying
              // awake to offer it again: offered once more, under the same
              // id, as a held send, with its pictures and files where the
              // desktop holds those too. The sends written after it go with
              // it, in order, so the desktop holds them all and none of them
              // waits on this phone; a steer is the desktop's to hold already.
              // Only the oldest send hands the line over, and only when every
              // send in it can be held: otherwise they all wait here, so a held
              // one cannot overtake one the phone still has.
              const line = [...outbox];
              if (
                line[0]?.[0] === frame.commandId &&
                line.every(([commandId, command]) => !command.steer && holdable(command) && !reheld.has(commandId))
              ) {
                for (const [commandId, command] of line) {
                  reheld.add(commandId);
                  outbox.delete(commandId);
                  const { uploadIds, ...words } = command;
                  const heldCommand = { ...words, ...(uploadIds?.length ? { uploadIds } : {}), queue: true as const };
                  held.set(commandId, { command: heldCommand, sentAfter: null, socket: -1 });
                  handlers.onSendHeld?.(commandId, heldCommand, afterSeq);
                }
                if (activeSendId && !outbox.has(activeSendId)) activeSendId = null;
                flushHeld();
                return;
              }
              handlers.onSendWaiting?.(frame.commandId);
              // The desktop has too many commands in flight from this socket,
              // or a turn running. The send stays queued under the same id and
              // goes again after the delay it asked for; it has not failed.
              if (activeSendId === frame.commandId) activeSendId = null;
              if (sendRetryTimer) clearTimeout(sendRetryTimer);
              sendRetryTimer = setTimeout(() => {
                sendRetryTimer = null;
                flushSend();
              }, frame.retryAfterMs ?? BUSY_RETRY_MS);
              return;
            }
            if (
              frame.type === "commandResult" &&
              outbox.has(frame.commandId) &&
              conversationSessionWasLost(frame) &&
              !resentAfterLostSession.has(frame.commandId)
            ) {
              // The server running the chat restarted after the desktop found
              // its session. The send did not run; offered again under the
              // same id, the desktop resumes the chat from its transcript and
              // sends it there. Once only: a second refusal is the answer.
              resentAfterLostSession.add(frame.commandId);
              if (activeSendId === frame.commandId) activeSendId = null;
              flushSend();
              return;
            }
            if (frame.type === "commandResult" && outbox.has(frame.commandId)) {
              outbox.delete(frame.commandId);
              if (activeSendId === frame.commandId && (!frame.ok || !busy)) {
                activeSendId = null;
                flushSend();
              }
            }
            // The probe's own answer is the stream's business, and has
            // already done its work by arriving.
            if (
              probeRequestId !== null &&
              (frame.type === "sessions" || frame.type === "result") &&
              frame.requestId === probeRequestId
            ) {
              probeRequestId = null;
              return;
            }
            if (frame.type === "error" && frame.retryAfterMs !== undefined)
              advisedRetryMs = frame.retryAfterMs;
            if (
              frame.type === "subscribeFailed" &&
              frame.key.workspaceId === key.workspaceId &&
              frame.key.agentId === key.agentId
            ) {
              // The socket is open but will never synchronize this key; left
              // alone the screen would say "synchronizing" for good.
              detach();
              handlers.onFrame(frame);
              if (frame.retryable) {
                handlers.onState("offline", frame.message);
                reconnect(frame.retryAfterMs);
              } else {
                halted = true;
                handlers.onState("unavailable", frame.message);
              }
              return;
            }
            handlers.onFrame(frame);
            for (const commandId of landed)
              handlers.onFrame({ type: "commandResult", commandId, ok: true });
            if (
              frame.type === "error" &&
              frame.code === "conversation_scope_required"
            )
              stop("blocked", frame.message);
          };
          next.onclose = (event) => {
            if (socket !== next || closed || dialing !== dialGeneration) return;
            if (event.code === REVOKED_CLOSE_CODE) {
              stop("revoked", REVOKED_MESSAGE);
              return;
            }
            if (
              event.code === CONVERSATION_SCOPE_CLOSE_CODE ||
              event.code === POLICY_CLOSE_CODE
            ) {
              stop(
                "blocked",
                "This device no longer has access to this conversation.",
              );
              return;
            }
            const advised =
              event.code === CONVERSATION_RESYNC_CLOSE_CODE
                ? (conversationCloseRetryAfterMs(event.reason ?? "") ??
                  advisedRetryMs)
                : advisedRetryMs;
            detach();
            handlers.onState(
              "offline",
              event.code === CONVERSATION_RESYNC_CLOSE_CODE
                ? "Catching up with the desktop…"
                : event.reason,
            );
            reconnect(advised);
          };
          next.onerror = () => {
            /* onclose owns retry */
          };
        } catch (error) {
          if (closed || dialing !== dialGeneration) return;
          if (error instanceof Error && error.message === REVOKED_MESSAGE) {
            stop("revoked", error.message);
            return;
          }
          if (
            error instanceof PeerRefusedError &&
            error.refusal.code === "peer_mismatch"
          ) {
            stop("blocked", error.message);
            return;
          }
          handlers.onState(
            "offline",
            error instanceof Error ? error.message : "Desktop is unavailable.",
          );
          reconnect();
        }
      };
      void dial();
      // Said once the stream is handed back, so a caller that closes on it
      // closes this stream rather than one not yet returned.
      if (staleAtOpen.length)
        void Promise.resolve().then(() => {
          for (const commandId of staleAtOpen)
            if (!closed && parked.has(commandId)) handlers.onSendStale?.(commandId);
        });
      return {
        command(command, suppliedId) {
          const commandId = suppliedId ?? identifier();
          if (command.kind === "send") {
            const problem = conversationSendProblem(commandId, command);
            if (problem) throw new Error(problem);
            take(commandId, command);
            flushSend();
            flushHeld();
          } else {
            if (!synchronized || !send({ type: "command", commandId, command }))
              throw new Error("Reconnect before using this action.");
          }
          return commandId;
        },
        cancelPending(commandId) {
          parked.delete(commandId);
          away.delete(commandId);
          if (activeSendId !== commandId) outbox.delete(commandId);
          // One already offered is the desktop's to give back (`cancelQueued`).
          if (held.get(commandId)?.sentAfter === null) held.delete(commandId);
        },
        request(frame) {
          const requestId = identifier();
          if (
            !synchronized ||
            !send({ ...frame, requestId } as ConversationClientFrame)
          )
            throw new Error(
              "Reconnect before requesting conversation details.",
            );
          return requestId;
        },
        foreground(backgroundMs) {
          if (closed || halted) return;
          if (
            backgroundMs >= FOREGROUND_REDIAL_MS ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
            // What waited while the app was away is offered only if it is
            // still young and its turn did not end meanwhile: the redial's
            // replay says which.
            for (const commandId of [...outbox.keys(), ...held.keys()]) away.add(commandId);
            if (heldByDesktop && reconnectTimer) return;
            // Back in front is a fresh start: a dial that fails now retries
            // in a second, not after the half-minute that failures while the
            // phone was away built up. Those failures said the phone had no
            // network, not that the desktop wanted to be left alone.
            attempt = 0;
            detach();
            handlers.onState("connecting");
            reconnect(undefined, true);
            return;
          }
          probe();
        },
        retry() {
          if (closed) return;
          halted = false;
          attempt = 0;
          detach();
          handlers.onState("connecting");
          reconnect(undefined, true);
        },
        close() {
          closed = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (sendRetryTimer) clearTimeout(sendRetryTimer);
          if (heldRetryTimer) clearTimeout(heldRetryTimer);
          if (probeTimer) clearTimeout(probeTimer);
          detach();
        },
      };
    },
    uploadImage(upload) {
      return uploadToChat(input, "conversation", upload);
    },
    uploadFile(upload) {
      return uploadToChat(input, "file", upload);
    },
    imageSource(ref) {
      return conversationImageSource(input, ref);
    },
    imageProblem(ref) {
      return readConversationImageProblem(input, ref);
    },
  };
}

/**
 * One upload to a chat's session, streamed from the file on the phone as the
 * request's body: a picture (`kind=conversation`) or, where the desktop
 * declares `conversation-message-files`, a file of any type (`kind=file`).
 * Answers the id the send names it by; a refusal is the desktop's own words.
 */
async function uploadToChat(
  target: { baseUrl: string; deviceToken: string },
  kind: "conversation" | "file",
  { sessionId, uri, name, mediaType }: { sessionId: string; uri: string; name: string; mediaType: string },
): Promise<string> {
  const what = kind === "file" ? "file" : "image";
  const url = `${target.baseUrl}${UPLOAD_PATH}?kind=${kind}&sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`;
  const result = await LegacyFileSystem.createUploadTask(url, uri, {
    httpMethod: "POST",
    uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      authorization: `Bearer ${target.deviceToken}`,
      "content-type": mediaType,
    },
  }).uploadAsync();
  if (!result) throw new Error(`The desktop refused the ${what} upload.`);
  if (result.status >= 400) {
    let refusal: unknown = null;
    try {
      refusal = JSON.parse(result.body);
    } catch {
      refusal = null;
    }
    throw new Error(kind === "file" ? conversationFileUploadRefusal(result.status, refusal) : conversationUploadRefusal(result.status, refusal));
  }
  const body = JSON.parse(result.body) as { uploadId?: unknown };
  if (typeof body.uploadId !== "string") throw new Error(`The desktop did not return an ${what} reference.`);
  return body.uploadId;
}
