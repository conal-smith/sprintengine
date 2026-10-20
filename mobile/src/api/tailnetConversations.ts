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
}
export interface ConversationStream {
  command(command: ConversationCommand, commandId?: string): string;
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
      pendingSends?: Array<{
        commandId: string;
        command: Extract<ConversationCommand, { kind: "send" }>;
        /** A held send's cursor when it was queued (`CachedConversation`). */
        heldAfter?: number;
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
}): ConversationApi {
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
      const take = (
        commandId: string,
        command: Extract<ConversationCommand, { kind: "send" }>,
        sentAfter: number | null = null,
      ) => {
        if (command.queue && queuedSends)
          held.set(commandId, { command, sentAfter, socket: -1 });
        else {
          const { queue: _queue, ...plain } = command;
          outbox.set(commandId, plain);
        }
      };
      for (const item of options?.pendingSends ?? [])
        take(item.commandId, item.command, item.heldAfter ?? initialSeq);
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
      const settleLandedHeld = (events: readonly ConversationEvent[]) => {
        const landed: string[] = [];
        for (const event of events) {
          if (event.type !== "user_message" || event.seq === undefined) continue;
          for (const [commandId, entry] of held) {
            if (entry.sentAfter === null || event.seq <= entry.sentAfter) continue;
            if (heldSendLanded(event, entry.command.message, entry.sentAfter)) {
              held.delete(commandId);
              landed.push(commandId);
            } else entry.sentAfter = Number.MAX_SAFE_INTEGER;
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
                unassembled.type === "queued") &&
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
                if (typeof commandId === "string") outbox.delete(commandId);
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
                if (typeof commandId === "string") outbox.delete(commandId);
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
            if (frame.type === "synchronized") {
              afterSeq = frame.seq;
              if (frame.generation !== undefined)
                logGeneration = frame.generation;
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
              // The desktop has too many commands in flight from this socket.
              // The send stays queued under the same id and goes again after
              // the delay it asked for; it has not failed.
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
            backgroundMs >= 10_000 ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
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
