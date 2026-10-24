import {
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  isConversationWirePermissionPreset,
  parseConversationWireModels,
  type ConversationWireModels,
  type ConversationWirePermissionPreset,
} from "./conversation-protocol/index";

// The phone's source mirror of the additive tailnet conversation lane. The
// desktop package is the authority until its npm release can be adopted here.
export const CONVERSATION_SOCKET_PATH = "/tailnet/v1/conversation";
export const CONVERSATION_CAPABILITY = "conversations";
export {
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_WIRE_PERMISSION_PRESETS,
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_IMAGES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_RESYNC_CLOSE_CODE,
  CONVERSATION_SCOPE_CLOSE_CODE,
  conversationCloseRetryAfterMs,
  presentToolItem,
} from "./conversation-protocol/index";

/**
 * `bypass` skips the CLI's prompts, `auto` lets edits in the workspace through
 * and asks before anything riskier, `manual` asks before every edit, command
 * and outside call, and `none` passes no permission flag. A desktop that does
 * not declare `conversation-permission-modes` runs only `none` and `bypass`.
 */
export type ConversationPermissionPreset = ConversationWirePermissionPreset;
/**
 * The capability a desktop declares when `resolvePlan` answers a plan request
 * as a plan. Without it a plan is answered as a `resolveApproval`, which every
 * desktop still takes.
 */
export const CONVERSATION_PLANS_CAPABILITY = "conversation-plans";
/**
 * The capability a desktop declares when its chat list carries each chat's
 * title, message, turn and visit clocks, leaves settled chats out, and takes
 * the `conversation.settle` and `conversation.visit` gateway tools.
 */
export const CONVERSATION_LIFECYCLE_CAPABILITY = "conversation-lifecycle";
/**
 * The capability a desktop declares when it takes the
 * `conversation.mark_unread` gateway tool, which moves a chat's
 * `lastVisitedAt` back to just before its latest finish. No `conversation-`
 * prefix: it names a tool, not the conversation lane.
 */
export const CHAT_MARK_UNREAD_CAPABILITY = "chat-mark-unread";
/**
 * The capability a desktop declares when it holds a message queued behind a
 * running turn and sends it itself when the turn ends: `send` takes `queue`,
 * `cancelQueued` takes a held message back, and `watchQueued` has it say what
 * it holds for the chat the socket follows, in `queued` frames. A message the
 * phone holds is lost if the phone sleeps, closes or drops off the tailnet
 * before the turn ends; one the desktop holds is not.
 */
export const CONVERSATION_QUEUED_SENDS_CAPABILITY = "conversation-queued-sends";
/**
 * The capability a desktop declares when `send` takes `steer`: the message
 * goes into the turn the chat is running instead of waiting for it to end. A
 * listed chat then says whether its CLI can take one (`capabilities.steer`).
 * Where the turn cannot take it after all (the CLI cannot steer, the turn is
 * waiting on an approval, or it ended on the way) the desktop holds the
 * message as a queued send and says so in the answer's `notice`, so a steer
 * is never lost. Absent, the phone offers no Steer: an older desktop drops
 * the flag and refuses a send mid-turn as busy.
 */
export const CONVERSATION_STEER_SENDS_CAPABILITY = "conversation-steer-sends";
/**
 * The capability a desktop declares when it takes `stopSubagent`: one agent
 * a chat spawned is stopped by itself, named by the call that spawned it (its
 * lane), and the chat, its turn and its other agents go on. A listed chat then
 * says whether its CLI can (`capabilities.stopSubagent`). Such a desktop's
 * turn Stop spares the agents, so this is the only way to stop one from here.
 */
export const CONVERSATION_STOP_SUBAGENT_CAPABILITY = "conversation-stop-subagent";
/** The most messages a desktop holds for one chat; it lists no more in a `queued` frame. */
export const CONVERSATION_MAX_QUEUED_MESSAGES = 20;
/** The longest refusal a held message carries; a longer one is dropped, the message kept. */
const MAX_QUEUED_FAILURE_CHARS = 2_000;

/**
 * One message the desktop holds for a chat until its turn ends
 * (`conversation-queued-sends`). The desktop joins what is queued in one turn
 * into one message, a line apiece, so a person who queued three lines sees one
 * entry here with three lines, and its `id` is what `cancelQueued` names.
 */
export interface ConversationQueuedMessage {
  id: string;
  text: string;
  /** When the desktop first held it, on its clock (epoch ms). */
  createdAt: number;
  /** The chat refused it when its turn came, in the chat's words. It waits on the person until taken back. */
  failure?: string;
}

export type ConversationPhase =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "failed"
  | "completed";
export interface ConversationKey {
  workspaceId: string;
  agentId: string;
}
export interface ConversationThread extends ConversationKey {
  title: string;
  phase: ConversationPhase;
  updatedAt: number;
  createdAt: number;
  providerId: string;
  modelId: string;
  turnCount: number;
  lastSeq: number;
  sessionId?: string;
  /**
   * The preset the chat runs under; absent from a desktop built before it was
   * listed, and for a preset this build does not know.
   */
  permissionPreset?: ConversationPermissionPreset;
  /**
   * The chat's CLI and the models it can switch between, from a desktop that
   * advertises `conversation-models`. Validated on receipt: a catalog in the
   * wrong shape is dropped, so the model control hides rather than guesses.
   */
  models?: ConversationWireModels;
  capabilities?: {
    images: boolean;
    approvals: boolean;
    questions: boolean;
    planMode: boolean;
    interrupt: boolean;
    checkpoints: boolean;
    /**
     * Whether the chat's CLI can take a message into a running turn, from a
     * desktop that declares `conversation-steer-sends`. Absent means unknown,
     * and the phone offers no Steer.
     */
    steer?: boolean;
    /**
     * Whether one agent the chat spawned can be stopped by itself, from a
     * desktop that declares `conversation-stop-subagent`. Absent means
     * unknown, and the phone offers no agent a Stop.
     */
    stopSubagent?: boolean;
    /**
     * The presets the chat's provider can run, from a desktop that declares
     * `conversation-permission-modes`. Absent means unknown.
     */
    permissionPresets?: ConversationPermissionPreset[];
  };
  /**
   * The machine the chat runs on, from a desktop that lists it: `local` for
   * the desktop itself, else `wsl:<distro>`, `ssh:<host>` or
   * `tailnet:<short host>`, with the kind and colour it is drawn in (the
   * person's override already applied). Absent from an older desktop, and
   * then the chat wears no machine mark.
   */
  host?: ConversationHost;
  /** The chat's pull requests, from a desktop that lists them; at most 20. */
  pullRequests?: ConversationPullRequest[];
  /**
   * The chat's title as the desktop's sidebar shows it, from a desktop that
   * advertises `conversation-lifecycle`. Absent, the list names the chat as
   * it always has (the workspace's name, else this thread's title).
   */
  chatTitle?: string;
  /**
   * When the person last sent the chat a message: the desktop's ordering key,
   * and the phone's. It moves for a message and nothing else.
   */
  lastUserMessageAt?: number;
  /**
   * When the agent's last turn finished. Unlike `updatedAt`, a rename, a
   * session starting or stopping, a usage report or a restart never moves it.
   */
  lastTurnEndedAt?: number;
  /**
   * When a person last had the chat on screen, on the desktop or any phone.
   * It moves forward, except by Mark unread (`conversation.mark_unread`, on a
   * desktop that advertises `chat-mark-unread`), which moves it back to just
   * before the chat's latest finish.
   */
  lastVisitedAt?: number;
  /**
   * When the chat was last marked unread, on the desktop's clock, from a
   * desktop that lists it beside `lastVisitedAt`. It only moves forward, and a
   * newer one is what lets the visit clock go back (`listedVisitRewind`).
   */
  visitRewoundAt?: number;
  /**
   * What the chat still has working after its turn ended, from a desktop that
   * lists it: the agents it launched in the background that still run, and
   * the monitors that will wake its agent. The desktop's sidebar counts such
   * a chat as working; `phase` stays the turn's, so a send is never held for
   * it. Absent when nothing works in the background, and from an older
   * desktop, which then reads as before: a chat whose turn ended is at rest.
   */
  backgroundWork?: ConversationBackgroundWork;
}
/** A listed chat's background work: at least one count is above zero. */
export interface ConversationBackgroundWork {
  agents: number;
  monitors: number;
}
/** Where a chat runs, as the desktop names and draws it. */
export interface ConversationHost {
  id: string;
  /** One of the desktop's machine kinds; read through `readMachineKind`. */
  kind: string;
  /** What the machine is called: "WSL: Ubuntu", "build-box". */
  label: string;
  /** One of the desktop's machine colours; read through `readMachineColour`. */
  color: string;
}
export type ConversationPullRequestState = "open" | "merged" | "closed";
export interface ConversationPullRequest {
  number: number;
  state: ConversationPullRequestState;
  url: string;
  title: string;
}
/** The id the desktop gives its own machine: a chat there wears no machine mark. */
export const CONVERSATION_LOCAL_HOST_ID = "local";
/** The most pull requests a listed chat carries; the desktop caps its list here too. */
export const CONVERSATION_MAX_PULL_REQUESTS = 20;
export interface ConversationEvent {
  id: string;
  seq?: number;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  type: string;
  createdAt: number;
  payload?: Record<string, unknown>;
}
export type ConversationClientFrame =
  | { type: "list"; requestId: string }
  /** Needs `conversation-hello`: answered with a `result` naming the protocol and capabilities. */
  | { type: "hello"; requestId: string }
  | {
      type: "subscribe";
      key: ConversationKey;
      afterSeq?: number;
      /** The log generation `afterSeq` came from; only sent alongside it. */
      generation?: string;
      turnLimit?: number;
    }
  | {
      type: "loadEarlier";
      requestId: string;
      beforeCursor: number;
      turnLimit?: number;
    }
  | { type: "getToolDetail"; requestId: string; toolUseId: string }
  | { type: "getTurnDiff"; requestId: string; turnSeq: number; path?: string }
  /** Needs `conversation-queued-sends`: sent after each subscription's fence. */
  | { type: "watchQueued"; requestId: string }
  | { type: "command"; commandId: string; command: ConversationCommand };
export type ConversationCommand =
  /**
   * `queue` (needs `conversation-queued-sends`) has the desktop hold the
   * message and send it when the chat's turn ends, answering as soon as it
   * holds it. A held message is its words alone, so `queue` never rides beside
   * `uploadIds`, not even an empty list: the desktop refuses the frame.
   */
  /**
   * `steer` (needs `conversation-steer-sends`) puts the message into the
   * running turn. Never beside `queue`, and the phone never sends one with
   * pictures: where the turn cannot take it the desktop holds it as a queued
   * send, and a held message is its words alone.
   */
  /**
   * `composedAt` is when the person pressed Send, on this phone's clock
   * (epoch ms), and rides every send. A desktop that reads it records it on
   * the message and refuses one written long ago as `stale`, unless
   * `confirmedStale` says the person tapped Send now on it here. One that does
   * not read it drops both and sends as it always did, so neither needs a
   * capability: the phone keeps its own rule (`queuedSends.ts`).
   */
  | {
      kind: "send";
      message: string;
      uploadIds?: string[];
      queue?: true;
      steer?: true;
      composedAt?: number;
      confirmedStale?: true;
    }
  /** Needs `conversation-queued-sends`: takes back a held message, refused once it is on its way. */
  | { kind: "cancelQueued"; queuedId: string }
  /** Needs `conversation-stop-subagent`: stops one agent by the call that spawned it, the chat going on. */
  | { kind: "stopSubagent"; toolUseId: string }
  | { kind: "interrupt" }
  | {
      kind: "resolveApproval";
      requestId: string;
      decision: "once" | "conversation" | "deny";
    }
  | {
      kind: "answerQuestion";
      requestId: string;
      answers: Record<string, string>;
    }
  | { kind: "setPermissionPreset"; preset: ConversationPermissionPreset }
  /** Needs `conversation-plans`: carries a proposed plan out, or sends the agent back to planning. */
  | { kind: "resolvePlan"; requestId: string; decision: "approve" | "reject" }
  /** Needs `conversation-models`: an id from the chat's `models.options`, or the CLI's own default. */
  | { kind: "setModel"; modelId: string };
export type ConversationServerFrame =
  | { type: "sessions"; requestId: string; sessions: ConversationThread[] }
  | { type: "event"; event: ConversationEvent }
  | {
      type: "snapshot";
      page: {
        events: ConversationEvent[];
        hasMore: boolean;
        beforeCursor: number | null;
      };
      reset?: true;
      generation?: string;
      /** One of several consecutive parts; apply only the assembled whole. */
      part?: { index: number; total: number };
      /** The conversation this replay belongs to; older desktops omit it. */
      key?: ConversationKey;
    }
  | {
      type: "synchronized";
      seq: number;
      generation?: string;
      key?: ConversationKey;
    }
  | {
      type: "subscribeFailed";
      key: ConversationKey;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | {
      type: "chunk";
      frameId: string;
      index: number;
      total: number;
      json: string;
    }
  | {
      type: "result";
      requestId: string;
      ok: boolean;
      data?: unknown;
      code?: string;
      message?: string;
      retryAfterMs?: number;
    }
  | {
      type: "commandResult";
      commandId: string;
      ok: boolean;
      code?: string;
      message?: string;
      /** A caveat on an accepted command: a model switch mid-turn applies from the next turn. */
      notice?: string;
      retryAfterMs?: number;
    }
  | { type: "error"; code: string; message: string; retryAfterMs?: number }
  /** What the desktop holds for `key`, whole each time; an empty list once nothing is. */
  | { type: "queued"; key: ConversationKey; messages: ConversationQueuedMessage[] };

const MAX_WIRE_TEXT = 256 * 1024;
const MAX_REASSEMBLED_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 1024;
const MAX_GROUPS = 4;
const MAX_SNAPSHOT_PARTS = 1024;
const wireBytes = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const wireKey = (value: unknown): value is ConversationKey =>
  record(value) &&
  typeof value.workspaceId === "string" &&
  typeof value.agentId === "string";
const generation = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const optionalDelay = (value: unknown) =>
  value === undefined || nonnegative(value);
function event(value: unknown): value is ConversationEvent {
  if (!record(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    (value.seq === undefined || nonnegative(value.seq)) &&
    typeof value.type === "string" &&
    nonnegative(value.createdAt) &&
    (value.payload === undefined || record(value.payload))
  );
}
function thread(value: unknown): value is ConversationThread {
  return (
    record(value) &&
    typeof value.workspaceId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.title === "string" &&
    typeof value.phase === "string" &&
    nonnegative(value.createdAt) &&
    nonnegative(value.updatedAt) &&
    nonnegative(value.lastSeq)
  );
}

// The listed catalog is replaced by its validated form, or removed. The
// permission preset is kept only when it is one the wire defines, and the
// presets the chat's provider can run are cut to those: a name this build has
// never heard of is left out rather than offered.
function threadWithCatalog(value: ConversationThread): ConversationThread {
  const {
    models,
    permissionPreset,
    capabilities,
    host,
    pullRequests,
    chatTitle,
    lastUserMessageAt,
    lastTurnEndedAt,
    lastVisitedAt,
    visitRewoundAt,
    backgroundWork,
    ...rest
  } = value as ConversationThread & {
    models?: unknown;
    permissionPreset?: unknown;
    capabilities?: unknown;
    host?: unknown;
    pullRequests?: unknown;
    chatTitle?: unknown;
    lastUserMessageAt?: unknown;
    lastTurnEndedAt?: unknown;
    lastVisitedAt?: unknown;
    visitRewoundAt?: unknown;
    backgroundWork?: unknown;
  };
  const background = parseConversationBackgroundWork(backgroundWork);
  const lifecycle = parseConversationLifecycle({
    chatTitle,
    lastUserMessageAt,
    lastTurnEndedAt,
    lastVisitedAt,
    visitRewoundAt,
  });
  const machine = parseConversationHost(host);
  const prs = parseConversationPullRequests(pullRequests);
  const catalog = models === undefined ? null : parseConversationWireModels(models);
  const flags = record(capabilities) ? capabilities : null;
  const { permissionPresets: listed, steer, stopSubagent, ...known } = flags ?? {};
  const presets = Array.isArray(listed) ? listed.filter(isConversationWirePermissionPreset) : null;
  return {
    ...rest,
    ...(isConversationWirePermissionPreset(permissionPreset) ? { permissionPreset } : {}),
    ...(catalog ? { models: catalog } : {}),
    ...(flags
      ? {
          capabilities: {
            ...(known as Omit<
              NonNullable<ConversationThread["capabilities"]>,
              "permissionPresets" | "steer" | "stopSubagent"
            >),
            ...(presets ? { permissionPresets: presets } : {}),
            // Kept only as a boolean: anything else reads as unknown, and
            // unknown offers no Steer.
            ...(typeof steer === "boolean" ? { steer } : {}),
            // The same: unknown offers no agent a Stop.
            ...(typeof stopSubagent === "boolean" ? { stopSubagent } : {}),
          },
        }
      : {}),
    ...(machine ? { host: machine } : {}),
    ...(prs.length ? { pullRequests: prs } : {}),
    ...(background ? { backgroundWork: background } : {}),
    ...lifecycle,
  };
}

/**
 * A listed chat's `backgroundWork`, or null: both counts whole and not
 * negative, one of them above zero. Anything else is left out, and the chat
 * reads as one with nothing working in the background.
 */
export function parseConversationBackgroundWork(value: unknown): ConversationBackgroundWork | null {
  if (!record(value) || !nonnegative(value.agents) || !nonnegative(value.monitors)) return null;
  if (value.agents === 0 && value.monitors === 0) return null;
  return { agents: value.agents, monitors: value.monitors };
}

type ConversationLifecycleFields = Pick<
  ConversationThread,
  "chatTitle" | "lastUserMessageAt" | "lastTurnEndedAt" | "lastVisitedAt" | "visitRewoundAt"
>;

/**
 * A listed chat's title and clocks, each kept only in the shape the
 * `conversation-lifecycle` contract gives it: a title that says something, and
 * instants that are whole, non-negative milliseconds. One in the wrong shape
 * is left out on its own, and the list reads that chat as an older desktop
 * would have sent it.
 */
export function parseConversationLifecycle(value: Record<string, unknown>): ConversationLifecycleFields {
  const out: ConversationLifecycleFields = {};
  if (typeof value.chatTitle === "string" && value.chatTitle.trim()) out.chatTitle = value.chatTitle.trim();
  for (const field of ["lastUserMessageAt", "lastTurnEndedAt", "lastVisitedAt", "visitRewoundAt"] as const) {
    if (nonnegative(value[field])) out[field] = value[field];
  }
  return out;
}

/**
 * A listed chat's `host`, or null when it is missing or malformed. Every field
 * must be a string and the id and label must say something: a host the phone
 * cannot name is a host it does not mark. The kind and colour are kept as sent
 * and read at the glyph, so an unknown kind still draws (as a desktop).
 */
export function parseConversationHost(value: unknown): ConversationHost | null {
  if (!record(value)) return null;
  const { id, kind, label, color } = value;
  if (typeof id !== "string" || typeof label !== "string") return null;
  if (!id.trim() || !label.trim()) return null;
  return {
    id: id.trim(),
    kind: typeof kind === "string" ? kind : "",
    label: label.trim(),
    color: typeof color === "string" ? color : "",
  };
}

const PULL_REQUEST_STATES: readonly string[] = ["open", "merged", "closed"];

/**
 * A listed chat's pull requests, each validated on its own: one in the wrong
 * shape, in a state this build does not know, or with an address that is not
 * a web page is left out rather than drawn. Capped at the desktop's 20.
 */
export function parseConversationPullRequests(value: unknown): ConversationPullRequest[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationPullRequest[] = [];
  for (const entry of value) {
    if (out.length >= CONVERSATION_MAX_PULL_REQUESTS) break;
    if (!record(entry)) continue;
    const { number, state, url, title } = entry;
    if (!Number.isSafeInteger(number) || Number(number) <= 0) continue;
    if (typeof state !== "string" || !PULL_REQUEST_STATES.includes(state)) continue;
    const address = pullRequestUrl(url);
    if (!address) continue;
    out.push({
      number: Number(number),
      state: state as ConversationPullRequestState,
      url: address,
      title: typeof title === "string" ? title : "",
    });
  }
  return out;
}

/** The longest pull request address the desktop lists; it drops a longer one too. */
const MAX_PULL_REQUEST_URL_LENGTH = 2_000;

/**
 * A pull request's address as the phone will hand it to the browser, or null.
 * Only a web page: `http(s)://`, a host, and no credentials before it, so
 * `https://github.com@elsewhere.example/` cannot pass for GitHub. The phone
 * opens the address the desktop gave and never builds one of its own.
 */
export function pullRequestUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (address.length > MAX_PULL_REQUEST_URL_LENGTH) return null;
  return /^https?:\/\/[^\s/?#@\\]+(?:[/?#][^\s]*)?$/iu.test(address) ? address : null;
}

export function conversationSocketUrl(baseUrl: string, ticket: string): string {
  const url = new URL(
    CONVERSATION_SOCKET_PATH,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export function parseConversationFrame(
  raw: string,
): ConversationServerFrame | null {
  if (
    raw.length > MAX_REASSEMBLED_BYTES ||
    wireBytes(raw) > MAX_REASSEMBLED_BYTES
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(value)) return null;
  const frame = value;
  if (typeof frame.type !== "string") return null;
  switch (frame.type) {
    case "sessions":
      return typeof frame.requestId === "string" &&
        Array.isArray(frame.sessions) &&
        frame.sessions.every(thread)
        ? {
            type: "sessions",
            requestId: frame.requestId,
            sessions: frame.sessions.map(threadWithCatalog),
          }
        : null;
    case "event":
      return event(frame.event) ? (frame as ConversationServerFrame) : null;
    case "snapshot":
      return record(frame.page) &&
        Array.isArray(frame.page.events) &&
        frame.page.events.every(event) &&
        typeof frame.page.hasMore === "boolean" &&
        (frame.page.beforeCursor === null ||
          nonnegative(frame.page.beforeCursor)) &&
        (frame.reset === undefined || frame.reset === true) &&
        (frame.generation === undefined || generation(frame.generation)) &&
        (frame.part === undefined ||
          (record(frame.part) &&
            nonnegative(frame.part.index) &&
            nonnegative(frame.part.total) &&
            Number(frame.part.total) <= MAX_SNAPSHOT_PARTS &&
            Number(frame.part.index) < Number(frame.part.total))) &&
        (frame.key === undefined || wireKey(frame.key))
        ? (frame as ConversationServerFrame)
        : null;
    case "synchronized":
      return nonnegative(frame.seq) &&
        (frame.generation === undefined || generation(frame.generation)) &&
        (frame.key === undefined || wireKey(frame.key))
        ? (frame as ConversationServerFrame)
        : null;
    case "subscribeFailed":
      return record(frame.key) &&
        typeof frame.key.workspaceId === "string" &&
        typeof frame.key.agentId === "string" &&
        typeof frame.code === "string" &&
        typeof frame.message === "string" &&
        typeof frame.retryable === "boolean" &&
        optionalDelay(frame.retryAfterMs)
        ? (frame as ConversationServerFrame)
        : null;
    case "chunk":
      return raw.length <= MAX_WIRE_TEXT &&
        typeof frame.frameId === "string" &&
        frame.frameId.length <= 200 &&
        nonnegative(frame.index) &&
        nonnegative(frame.total) &&
        Number(frame.total) > 0 &&
        Number(frame.total) <= MAX_CHUNKS &&
        typeof frame.json === "string" &&
        frame.json.length <= MAX_WIRE_TEXT
        ? (frame as ConversationServerFrame)
        : null;
    case "result":
      return typeof frame.requestId === "string" &&
        typeof frame.ok === "boolean" &&
        optionalDelay(frame.retryAfterMs)
        ? (frame as ConversationServerFrame)
        : null;
    case "commandResult": {
      if (
        typeof frame.commandId !== "string" ||
        typeof frame.ok !== "boolean" ||
        !optionalDelay(frame.retryAfterMs)
      )
        return null;
      // A notice only qualifies an accepted command; anything else is dropped.
      const { notice, ...rest } = frame;
      return {
        ...(rest as Extract<ConversationServerFrame, { type: "commandResult" }>),
        ...(frame.ok === true && typeof notice === "string" && notice.length <= 2_000
          ? { notice }
          : {}),
      };
    }
    case "error":
      return typeof frame.code === "string" &&
        typeof frame.message === "string" &&
        optionalDelay(frame.retryAfterMs)
        ? (frame as ConversationServerFrame)
        : null;
    case "queued":
      return wireKey(frame.key) && Array.isArray(frame.messages)
        ? {
            type: "queued",
            key: { workspaceId: frame.key.workspaceId, agentId: frame.key.agentId },
            messages: parseQueuedMessages(frame.messages),
          }
        : null;
    default:
      return null;
  }
}

/**
 * A `queued` frame's messages, read as the desktop's contract reads them:
 * each entry on its own, so one this build cannot read does not hide the
 * rest, and no more than the desktop's twenty. An id says something and fits
 * the wire's 200 characters, the text is a message the desktop could send,
 * and a refusal longer than 2,000 characters is dropped with the message kept.
 */
export function parseQueuedMessages(value: readonly unknown[]): ConversationQueuedMessage[] {
  const messages: ConversationQueuedMessage[] = [];
  for (const entry of value) {
    if (messages.length >= CONVERSATION_MAX_QUEUED_MESSAGES) break;
    if (
      !record(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > 200 ||
      typeof entry.text !== "string" ||
      entry.text.length > CONVERSATION_MAX_MESSAGE_CHARS ||
      !nonnegative(entry.createdAt)
    )
      continue;
    messages.push({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      ...(typeof entry.failure === "string" && entry.failure.length <= MAX_QUEUED_FAILURE_CHARS
        ? { failure: entry.failure }
        : {}),
    });
  }
  return messages;
}

/**
 * Whether a `user_message` is a message the phone handed the desktop to hold
 * and has not heard back about: one that came into the chat after the phone
 * first offered it (`afterSeq`, the phone's cursor then) and carries its
 * words as whole lines. The desktop joins messages queued in one turn, a line
 * apiece, and sends the join under an id of its own, so the words are all
 * there is to know it by. Read only for a held send still unanswered: an
 * answer lost with a dropped socket would otherwise have the phone offer it
 * again after the desktop had already sent it, and the desktop, no longer
 * holding it, would hold it a second time.
 *
 * The trade-off: words are not an identity. If the offer never reached the
 * desktop at all, and a message with the same words reaches the chat after
 * it from elsewhere (a "yes" typed on the desktop), the phone takes that for
 * delivery and the phone's "yes" is never sent. The stream narrows this to
 * the first person's message after the offer (the desktop sends what it
 * holds before anything sent later, and refuses or joins a send made while
 * the turn runs), so only that one message can be mistaken for it. Losing a
 * repeat of words the chat has just been sent is the lesser harm: the other
 * error is the agent being told the same thing twice, a second turn spent on
 * it, with no way for the person to take it back.
 */
export function heldSendLanded(
  event: Pick<ConversationEvent, "type" | "seq" | "payload">,
  message: string,
  afterSeq: number,
): boolean {
  if (event.type !== "user_message" || event.seq === undefined || event.seq <= afterSeq) return false;
  const text = event.payload?.text;
  const words = message.trim();
  if (typeof text !== "string" || !words) return false;
  return `\n${text}\n`.includes(`\n${words}\n`);
}

/** A reassembled frame is emitted only once all numbered chunks arrived. */
export function createConversationChunkAssembler() {
  const partial = new Map<
    string,
    {
      total: number;
      parts: Array<string | undefined>;
      received: number;
      size: number;
    }
  >();
  const size = () =>
    [...partial.values()].reduce((sum, item) => sum + item.size, 0);
  return {
    push(frame: ConversationServerFrame): ConversationServerFrame | null {
      if (frame.type !== "chunk") return frame;
      if (
        frame.total < 1 ||
        frame.total > MAX_CHUNKS ||
        frame.index < 0 ||
        frame.index >= frame.total
      )
        return null;
      if (!partial.has(frame.frameId) && partial.size >= MAX_GROUPS)
        partial.delete(partial.keys().next().value!);
      const entry = partial.get(frame.frameId) ?? {
        total: frame.total,
        parts: new Array<string | undefined>(frame.total),
        received: 0,
        size: 0,
      };
      if (entry.total !== frame.total) return null;
      if (entry.parts[frame.index] === undefined) {
        entry.received++;
        entry.size += wireBytes(frame.json);
      } else
        entry.size +=
          wireBytes(frame.json) - wireBytes(entry.parts[frame.index]!);
      if (entry.size > MAX_REASSEMBLED_BYTES) {
        partial.delete(frame.frameId);
        return null;
      }
      entry.parts[frame.index] = frame.json;
      partial.set(frame.frameId, entry);
      while (size() > MAX_REASSEMBLED_BYTES)
        partial.delete(partial.keys().next().value!);
      if (!partial.has(frame.frameId)) return null;
      if (entry.received !== entry.total) return null;
      partial.delete(frame.frameId);
      return parseConversationFrame(entry.parts.join(""));
    },
    reset(): void {
      partial.clear();
    },
  };
}

type SnapshotFrame = Extract<ConversationServerFrame, { type: "snapshot" }>;
/**
 * A snapshot too big for one frame arrives as consecutive parts whose events
 * concatenate in order. Only the whole is applied: a partial snapshot would
 * replace the transcript with its first slice. Anything out of order drops
 * the parts collected so far; the fence that follows cannot be trusted
 * without them, so the caller resubscribes when `broken` is reported.
 */
export function createSnapshotAssembler() {
  let pending: {
    frame: SnapshotFrame;
    events: ConversationEvent[];
    next: number;
    total: number;
  } | null = null;
  return {
    push(
      frame: SnapshotFrame,
    ): { snapshot: SnapshotFrame } | { waiting: true } | { broken: true } {
      const part = frame.part;
      if (!part) {
        const interrupted = pending !== null;
        pending = null;
        return interrupted ? { broken: true } : { snapshot: frame };
      }
      if (part.index === 0)
        pending = { frame, events: [], next: 0, total: part.total };
      if (!pending || part.index !== pending.next || part.total !== pending.total) {
        pending = null;
        return { broken: true };
      }
      pending.events.push(...frame.page.events);
      pending.next++;
      if (pending.next < pending.total) return { waiting: true };
      const { part: _part, ...first } = pending.frame;
      const whole: SnapshotFrame = {
        ...first,
        page: { ...frame.page, events: pending.events },
      };
      pending = null;
      return { snapshot: whole };
    },
    reset(): void {
      pending = null;
    },
  };
}

/**
 * The refusal of a command about a session the desktop's runtime no longer
 * holds: the Studio server running the chat restarted (a WSL distribution's,
 * an SSH machine's, the desktop's own out of process) between the desktop
 * finding the session and using it. The runtime names it
 * `session_not_found`. The tailnet lane passes no runtime code on, so there it
 * arrives as `unavailable` carrying the runtime's own sentence, which says
 * this and nothing else; the desktop's chat view reads it the same way.
 */
export const CONVERSATION_SESSION_NOT_FOUND = "session_not_found";
const LOST_SESSION_WORDS = "Conversation session is invalid.";
export function conversationSessionWasLost(result: { ok: boolean; code?: string; message?: string }): boolean {
  if (result.ok) return false;
  if (result.code === CONVERSATION_SESSION_NOT_FOUND) return true;
  return (result.code === undefined || result.code === "unavailable") && result.message === LOST_SESSION_WORDS;
}
/** What an answer to a request on a lost session is told: nothing waits for it now. */
export const LOST_REQUEST_SENTENCE =
  "This request ended with the session it belonged to (the server running the chat restarted). Send a message to carry on.";

/**
 * Line and paragraph separators as one plain line break. The phone's
 * recogniser, the keyboard's dictation or a paste can hand the composer
 * U+2028, U+2029, U+0085 or a carriage return; a message goes to the desktop
 * with plain line breaks, whatever typed or pasted it.
 */
export function plainLineBreaks(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029\u0085]/gu, "\n");
}

/**
 * Why a send cannot go to the desktop as written, or null when it can. The
 * limits are the protocol's own, so a message this accepts is never refused
 * for size and one it refuses never reaches the durable outbox, where it
 * would be retried on every reconnect.
 */
export function conversationSendProblem(
  commandId: string,
  command: Extract<ConversationCommand, { kind: "send" }>,
): string | null {
  // The desktop refuses the frame whole, so it is never offered at all.
  if (command.steer === true && (command.queue === true || command.uploadIds !== undefined))
    return "A message steered into the turn carries its words alone.";
  if (command.message.length > CONVERSATION_MAX_MESSAGE_CHARS)
    return `This message is ${command.message.length.toLocaleString("en-US")} characters; the desktop accepts at most ${CONVERSATION_MAX_MESSAGE_CHARS.toLocaleString("en-US")}.`;
  const frame: ConversationClientFrame = { type: "command", commandId, command };
  if (wireBytes(JSON.stringify(frame)) > CONVERSATION_MAX_CLIENT_FRAME_BYTES)
    return "This message is too large to send to the desktop.";
  return null;
}
