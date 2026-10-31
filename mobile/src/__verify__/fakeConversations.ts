import type { ConversationLifecycleApi } from "../api/conversationLifecycle";
import type { ConversationApi, ConversationStreamHandlers } from "../api/tailnetConversations";
import type { ConversationEvent, ConversationQueuedMessage, ConversationThread } from "../api/conversationWire";
import { chatOpenedKey } from "../features/conversations/conversationListLogic";

// The conversation the screenshot harness opens. EXPO_PUBLIC_VERIFY_CONVERSATION
// picks what it shows, one per 2026-09-29 mockup screen:
//
//   (any)  a turn at work: two agents working, one finished with what it said
//          and its report, one failed, a compaction divider, a code block and
//          a queued message floating over the transcript
//   idle   the same chat settled, its prompt cache about to go cold
//   plan   a turn waiting on a permission, a question and a plan
//   queued-failed  the turn at work, with a message the desktop held from an
//          earlier turn that the chat refused when its turn came
//
// The fake desktop holds queued messages (`conversation-queued-sends`): a
// send that says `queue` is held and joined, a line apiece, with what else
// the turn has queued, listed in a `queued` frame after each fence and on
// every change, and sent when the turn ends; `cancelQueued` takes one back.
// It takes a steer too (`conversation-steer-sends`): a send that says `steer`
// lands in the running turn as the person's message, and the turn runs on.
// And it stops one agent by itself (`conversation-stop-subagent`): the agent
// reports itself stopped, and the turn and the other agents run on.
//
// The settled turn also looked at a screenshot and had Codex draw a picture:
// the picture shows under its step, and the screenshot when its step opens.
//
// The settled turn changed three files (one modified in two places, one
// added, one deleted), which its "View changed files" row opens onto.
//
// Times are relative to launch, so the live clocks and the cache's expiry
// read as they would on a real chat.
//
// The chat list, from a desktop that advertises `conversation-lifecycle`,
// reads in the order each chat was last written in:
//
//   Remote conversation launch   working; written in a minute ago
//   Docs: the list's own rules   green: its turn ended after anyone last saw it
//   Review the plan: pair by…    gold: waiting on an approval, and staying put
//                                under the chat written in after it
//   Fix the flaky pairing test   failed: its last turn stopped two hours ago
//   Toast timeouts on the phone  no wash: its turn ended, then it was read on
//                                the desktop
//
// Opened, the green row's chat holds two turns: one that ended before its
// last visit and one after, so it opens on the "New" divider above the second.
// The gold row's chat opens on its approval, question and plan, and the failed
// row's on its failed turn; every other chat opens onto the fixture chat's
// history.
//
// Two more rest under Earlier: one where Studio wrote to the chat itself (an
// agent it launched reporting back, a resume after a usage limit), drawn as
// Studio's rows, and one whose message attached four files by path, drawn as
// cards under the person's bubble.
//
// A fifth chat's workspace is settled. The fake lists it anyway, as a desktop
// mid-update might, so it is the phone's own drop that keeps it off the list.
// Settle on any row takes it off every later list; a visit moves the chat's
// `lastVisitedAt`, and Mark unread (the fake desktop advertises
// `chat-mark-unread`) moves it back to just before the chat's latest finish,
// as the desktop does. Opened and left, the green row's chat can be marked
// unread from its row's long press or its More menu, and opened again on the
// "New" divider above its second turn.
const scenario = process.env.EXPO_PUBLIC_VERIFY_CONVERSATION;
const launchedAt = Date.now();
const at = (agoMs: number) => launchedAt - agoMs;
const seconds = 1000;
const minutes = 60 * seconds;

// The chat's models: Opus 5.5 at two context windows, one row with the
// window as its second choice, and Fable 5, which the desktop's catalog marks
// New (the chat's own list does not carry the mark; the picker matches it by
// id against `cli.runtime.list`).
const models: ConversationThread["models"] = {
  cli: "claude-code",
  cliLabel: "Claude Code",
  liveModelSwitch: true,
  options: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M context)" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-fable-5", label: "Fable 5" },
  ],
};
export const verifyConversation: ConversationThread = {
  workspaceId: "ws-studio",
  chatTitle:
    scenario === "plan"
      ? "Review the plan: pair by link"
      : scenario === "idle"
        ? "Toast timeouts on the phone"
        : "Remote conversation launch",
  lastUserMessageAt: at(1 * minutes),
  lastTurnEndedAt: at(62 * minutes),
  lastVisitedAt: at(61 * minutes),
  agentId: "agent-example",
  sessionId: "session-example",
  title:
    scenario === "plan"
      ? "Review the plan: pair by link"
      : scenario === "idle"
        ? "Toast timeouts on the phone"
        : "Remote conversation launch",
  phase: scenario === "plan" ? "waiting_for_approval" : scenario === "idle" ? "completed" : "running",
  updatedAt: at(0),
  createdAt: at(80 * minutes),
  providerId: "claude-code",
  modelId: "claude-opus-5-5",
  permissionPreset: "bypass",
  models,
  turnCount: 2,
  lastSeq: 0,
  capabilities: {
    images: true,
    approvals: true,
    questions: true,
    planMode: true,
    interrupt: true,
    checkpoints: true,
    permissionPresets: ["manual", "none", "auto", "bypass"],
    steer: true,
    stopSubagent: true,
  },
  // Runs in a WSL distribution on the paired desktop, so it wears that
  // machine's mark; its pull request is open.
  host: { id: "wsl:Ubuntu", kind: "wsl", label: "WSL: Ubuntu", color: "teal" },
  pullRequests: [
    { number: 42, state: "open", url: "https://github.com/acme/multicode/pull/42", title: "Launch a chat from the phone" },
    { number: 37, state: "closed", url: "https://github.com/acme/multicode/pull/37", title: "First try" },
  ],
};
/** A chat on the desktop itself: no machine mark, and a merged pull request. */
const verifyLocalConversation: ConversationThread = {
  ...verifyConversation,
  agentId: "agent-local",
  sessionId: "session-local",
  title: "Toast timeouts on the phone",
  chatTitle: "Toast timeouts on the phone",
  phase: "completed",
  // Renamed a minute ago, which moves `updatedAt` and nothing else: its turn
  // ended three hours ago and it was read on the desktop after that.
  updatedAt: at(1 * minutes),
  lastUserMessageAt: at(3 * 60 * minutes + 10 * minutes),
  lastTurnEndedAt: at(3 * 60 * minutes),
  lastVisitedAt: at(2 * 60 * minutes),
  host: { id: "local", kind: "laptop", label: "This Mac", color: "blue" },
  pullRequests: [{ number: 39, state: "merged", url: "https://github.com/acme/multicode/pull/39", title: "Toasts clear themselves" }],
};
/** Finished twelve minutes ago, and nobody has looked since: the green row. */
const verifyUnseenConversation: ConversationThread = {
  ...verifyConversation,
  workspaceId: "ws-docs",
  agentId: "agent-docs",
  sessionId: "session-docs",
  title: "Docs: the list's own rules",
  chatTitle: "Docs: the list's own rules",
  phase: "completed",
  updatedAt: at(12 * minutes),
  lastUserMessageAt: at(20 * minutes),
  lastTurnEndedAt: at(12 * minutes),
  lastVisitedAt: at(25 * minutes),
  host: undefined,
  pullRequests: undefined,
};
/**
 * Waiting on an approval: the gold row. It moved half a minute ago, and was
 * last written in fifty minutes ago, so it sits under the green one.
 */
const verifyWaitingConversation: ConversationThread = {
  ...verifyConversation,
  workspaceId: "ws-plan",
  agentId: "agent-plan",
  sessionId: "session-plan",
  title: "Review the plan: pair by link",
  chatTitle: "Review the plan: pair by link",
  phase: "waiting_for_approval",
  updatedAt: at(30 * seconds),
  lastUserMessageAt: at(50 * minutes),
  lastTurnEndedAt: at(55 * minutes),
  lastVisitedAt: at(50 * minutes),
  host: undefined,
  pullRequests: undefined,
};
/** Its last turn failed two hours ago: no wash, the error's mark and word. */
const verifyFailedConversation: ConversationThread = {
  ...verifyConversation,
  workspaceId: "ws-flaky",
  agentId: "agent-flaky",
  sessionId: "session-flaky",
  title: "Fix the flaky pairing test",
  chatTitle: "Fix the flaky pairing test",
  phase: "failed",
  updatedAt: at(2 * 60 * minutes),
  lastUserMessageAt: at(2 * 60 * minutes + 10 * minutes),
  lastTurnEndedAt: at(2 * 60 * minutes),
  lastVisitedAt: at(2 * 60 * minutes + 5 * minutes),
  host: undefined,
  pullRequests: undefined,
};
/** Settled on the desktop: it must never reach the phone's list. */
const verifySettledConversation: ConversationThread = {
  ...verifyUnseenConversation,
  workspaceId: "ws-settled",
  agentId: "agent-settled",
  sessionId: "session-settled",
  title: "Settled: bump the icons",
  chatTitle: "Settled: bump the icons",
  lastUserMessageAt: at(30 * seconds),
  lastTurnEndedAt: at(10 * seconds),
};

/**
 * A reply's diagrams and math, every case at rest: a flowchart, a sequence
 * diagram, display math in each of its spellings, a ```latex fence that stays
 * code, prices and citations that stay text, and the ones shown as source (a
 * diagram with a typo, one that asks for a picture from the web, a formula
 * that does not parse). Written in three days ago, so it rests under Earlier
 * and the top of the list photographs as before.
 */
const verifyRichConversation: ConversationThread = {
  ...verifyConversation,
  workspaceId: "ws-rich",
  agentId: "agent-rich",
  sessionId: "session-rich",
  title: "Diagrams and math in a reply",
  chatTitle: "Diagrams and math in a reply",
  phase: "completed",
  updatedAt: at(3 * 24 * 60 * minutes),
  lastUserMessageAt: at(3 * 24 * 60 * minutes + 5 * minutes),
  lastTurnEndedAt: at(3 * 24 * 60 * minutes),
  lastVisitedAt: at(3 * 24 * 60 * minutes - minutes),
  host: undefined,
  pullRequests: undefined,
};
/**
 * The same, streaming: opened for the first time after launch, it replays a
 * reply a few characters at a time, so its diagram and its formula show as
 * source until each block is complete and then draw, mid-reply.
 */
const verifyRichLiveConversation: ConversationThread = {
  ...verifyRichConversation,
  workspaceId: "ws-rich-live",
  agentId: "agent-rich-live",
  sessionId: "session-rich-live",
  title: "Diagrams and math, streaming",
  chatTitle: "Diagrams and math, streaming",
  lastUserMessageAt: at(3 * 24 * 60 * minutes + 10 * minutes),
};

/**
 * Messages Studio sent the chat itself: an agent the chat launched reporting
 * back, and a resume once a usage limit reset. Each is Studio's quiet row, not
 * the person's bubble, and neither is the person writing: the list's clock is
 * the person's last message, before the resume. It was last looked at before
 * the agent's news, so it opens on "New" above Studio's row. Two days old, so
 * it rests under Earlier.
 */
const verifyNoticesConversation: ConversationThread = {
  ...verifyConversation,
  workspaceId: "ws-notices",
  agentId: "agent-notices",
  sessionId: "session-notices",
  title: "Audit the pairing flow",
  chatTitle: "Audit the pairing flow",
  phase: "completed",
  updatedAt: at(2 * 24 * 60 * minutes),
  lastUserMessageAt: at(2 * 24 * 60 * minutes + 15 * minutes),
  lastTurnEndedAt: at(2 * 24 * 60 * minutes),
  lastVisitedAt: at(2 * 24 * 60 * minutes + 30 * minutes),
  host: undefined,
  pullRequests: undefined,
};
/**
 * A message with files attached by path: a PDF, a DOCX on a Windows
 * drive, a spreadsheet on a Windows share, and a file of no kind the phone
 * names. Under Earlier too.
 */
const verifyFilesConversation: ConversationThread = {
  ...verifyNoticesConversation,
  workspaceId: "ws-files",
  agentId: "agent-files",
  sessionId: "session-files",
  title: "Compare the quarter against the plan",
  chatTitle: "Compare the quarter against the plan",
  updatedAt: at(2 * 24 * 60 * minutes + 50 * minutes),
  lastUserMessageAt: at(2 * 24 * 60 * minutes + 55 * minutes),
  lastTurnEndedAt: at(2 * 24 * 60 * minutes + 50 * minutes),
  lastVisitedAt: at(2 * 24 * 60 * minutes + 45 * minutes),
};

/**
 * When the harness's phone last opened each chat, as the device notes would
 * hold it. Without a stamp a chat's first sighting counts as seen, and the
 * green row would never light.
 */
export const verifyChatsOpened: Record<string, number> = {
  [chatOpenedKey("dev_verify", verifyUnseenConversation.agentId)]: at(40 * minutes),
  [chatOpenedKey("dev_verify", verifyLocalConversation.agentId)]: at(5 * 60 * minutes),
  [chatOpenedKey("dev_verify", verifyWaitingConversation.agentId)]: at(50 * minutes),
  [chatOpenedKey("dev_verify", verifyFailedConversation.agentId)]: at(2 * 60 * minutes + 5 * minutes),
  [chatOpenedKey("dev_verify", verifyConversation.agentId)]: at(1 * minutes),
};

/** Workspaces settled on the fake desktop, and when; the workspace list reads it too. */
export const verifySettledAt = new Map<string, number>([[verifySettledConversation.workspaceId, at(2 * 60 * minutes)]]);
/** The visit clock of each chat the fake desktop has stamped or marked unread, by workspace. */
const visitedAt = new Map<string, number>();

/** When each chat the fake desktop has snoozed wakes, by workspace. */
const snoozedUntil = new Map<string, number>();

/** `conversation.settle`, `conversation.visit`, `conversation.mark_unread` and `conversation.snooze` on the fake desktop. */
export const fakeLifecycleApi: ConversationLifecycleApi = {
  async settle(workspaceId, settled = true) {
    const settledAt = settled ? Date.now() : null;
    if (settledAt === null) verifySettledAt.delete(workspaceId);
    else verifySettledAt.set(workspaceId, settledAt);
    return { ok: true, data: { workspaceId, settledAt } };
  },
  async visit(workspaceId) {
    const lastVisitedAt = Math.max(visitedAt.get(workspaceId) ?? 0, Date.now());
    visitedAt.set(workspaceId, lastVisitedAt);
    return { ok: true, data: { workspaceId, lastVisitedAt } };
  },
  async markUnread(workspaceId) {
    const thread = fakeListed().find((entry) => entry.workspaceId === workspaceId);
    const finishedAt = thread?.lastTurnEndedAt;
    if (finishedAt === undefined)
      return {
        ok: false,
        errorCode: "invalid_payload",
        message: "No agent in this chat has finished anything yet, so there is nothing to mark unread.",
      };
    // A chat already unread from further back keeps its clock.
    const stored = visitedAt.get(workspaceId) ?? thread?.lastVisitedAt;
    const lastVisitedAt = stored !== undefined && stored < finishedAt - 1 ? stored : finishedAt - 1;
    visitedAt.set(workspaceId, lastVisitedAt);
    return { ok: true, data: { workspaceId, lastVisitedAt } };
  },
  async snooze(workspaceId, until) {
    if (until === null) snoozedUntil.delete(workspaceId);
    else snoozedUntil.set(workspaceId, until);
    return { ok: true, data: { workspaceId, snoozedUntil: until } };
  },
};

let sequence = 0;
const event = (
  type: string,
  payload: Record<string, unknown>,
  agoMs = 0,
  owner: ConversationThread = verifyConversation,
): ConversationEvent =>
  ({
    id: `event-${++sequence}`,
    seq: sequence,
    workspaceId: owner.workspaceId,
    agentId: owner.agentId,
    sessionId: owner.sessionId!,
    // The desktop stamps the model on every event; turn meta reads it.
    modelId: "claude-opus-5-5",
    type,
    payload,
    createdAt: at(agoMs),
  }) as ConversationEvent;
const tool = (id: string, name: string, input: Record<string, unknown>, agoMs: number, extra: Record<string, unknown> = {}) =>
  event("tool_started", { turnId: extra.turnId ?? "turn-one", toolUseId: id, name, input, ...extra }, agoMs);
const done = (id: string, output: string, agoMs: number, extra: Record<string, unknown> = {}) =>
  event("tool_output", { turnId: extra.turnId ?? "turn-one", toolUseId: id, output, status: "ok", ...extra }, agoMs);

// A turn that settled an hour ago: compacted on the way in, a run of steps
// with one failure, a reply with code, and the cache reading it left behind.
function settledTurn(): ConversationEvent[] {
  const turn = { turnId: "turn-zero" };
  return [
    event("user_message", { ...turn, text: "Make warn and error toasts clear themselves too." }, 60 * minutes),
    event("turn_started", turn, 60 * minutes),
    event("context_compacted", { ...turn, trigger: "auto", preTokens: 182_000, postTokens: 24_000 }, 59 * minutes),
    tool("edit-toast", "Edit", { path: "src/components/Toast.tsx" }, 59 * minutes, turn),
    done("edit-toast", "Updated", 59 * minutes, turn),
    tool("edit-store", "Edit", { path: "src/components/toastStore.ts" }, 58 * minutes, turn),
    done("edit-store", "Updated", 58 * minutes, turn),
    tool("test", "Bash", { command: "npm run test:mobile" }, 58 * minutes, turn),
    done("test", "Exit code 1\n1 failing", 58 * minutes, { ...turn, status: "error", isError: true, exitCode: 1 }),
    event(
      "content_delta",
      {
        ...turn,
        text:
          "Warn and error toasts now clear themselves, like the desktop's. **Neutral and success** leave after 5 s; **warn and error** after 10 s. Pressing and holding a toast holds its clock.\n\n```Toast.tsx\nexport const AUTO_DISMISS_MS = {\n  neutral: 5_000, success: 5_000,\n  warn: 10_000, error: 10_000,\n} as const;\n```",
      },
      57 * minutes,
    ),
    // A screenshot it looked at, and a picture it generated: the step starts
    // with no path, and the desktop adds the path once it has saved it.
    tool("look", "Read", { path: "/tmp/toast-before.png" }, 57 * minutes, turn),
    done("look", "", 57 * minutes, turn),
    tool("picture", "GenerateImage", {}, 57 * minutes, turn),
    tool(
      "picture",
      "GenerateImage",
      { prompt: "A flat orange sun over a pale sky, as a toast's icon", path: "/Users/dev/.codex/generated_images/ig_1.png" },
      57 * minutes,
      turn,
    ),
    done("picture", "", 57 * minutes, turn),
    // An hour's cache, written 57 minutes ago: three minutes left.
    event("usage_updated", { ...turn, promptCache: { ttl: "1h", cached: true, recacheTokens: 412_000 } }, 57 * minutes),
    // The context window as the desktop reports it, for the strip's ring.
    event("usage_updated", { ...turn, contextWindow: 200_000, contextUsed: 76_000 }, 57 * minutes),
    event("turn_completed", { ...turn, durationMs: 134_000, checkpointAvailable: true }, 57 * minutes),
  ];
}

// A turn at work, fanned out to four agents.
function workingTurn(): ConversationEvent[] {
  const turn = { turnId: "turn-one" };
  const lane = (id: string, type: string, description: string, agoMs: number, background = true) => [
    tool(id, "Task", { description, subagent_type: type, prompt: description }, agoMs, { subagentLane: true, subagentType: type }),
    event("subagent_status", { toolUseId: id, status: "running", background, subagentType: type, description }, agoMs),
  ];
  const step = (id: string, parent: string, name: string, input: Record<string, unknown>, agoMs: number) =>
    tool(id, name, input, agoMs, { parentToolUseId: parent });
  const said = (parent: string, text: string, agoMs: number) =>
    event("subagent_message", { parentToolUseId: parent, text }, agoMs);
  return [
    event("user_message", { ...turn, text: "Can the phone start a chat on the desktop now? Check the gateway and the mesh service." }, 252 * seconds),
    event("turn_started", turn, 252 * seconds),
    event("content_delta", { ...turn, text: "I'll look at the gateway's tools and the mesh caller side by side." }, 250 * seconds),
    ...["studio-gateway-tools.ts", "tailnet-mesh-service.ts", "conversation-tools.ts", "tailnet-scopes.ts"].flatMap((file, index) => [
      tool(`read-${index}`, "Read", { path: `src/main/automation/tailnet/${file}` }, (248 - index) * seconds),
      done(`read-${index}`, "…", (247 - index) * seconds),
    ]),
    tool("grep", "Grep", { pattern: "conversation.create" }, 243 * seconds),
    done("grep", "12 hits", 242 * seconds),
    // Finished: what it said between its steps, then its report.
    ...lane("agent-mesh", "Explore", 'Find where the mesh maps "Unknown tool"', 230 * seconds, false),
    said("agent-mesh", "Starting from the mesh caller, then where it reads a tool's refusal.", 229 * seconds),
    step("mesh-grep", "agent-mesh", "Grep", { pattern: "Unknown tool" }, 225 * seconds),
    done("mesh-grep", "3 hits", 224 * seconds, { parentToolUseId: "agent-mesh" }),
    step("mesh-read", "agent-mesh", "Read", { path: "src/main/automation/tailnet/tailnet-mesh-service.ts" }, 200 * seconds),
    done("mesh-read", "…", 199 * seconds, { parentToolUseId: "agent-mesh" }),
    said("agent-mesh", "The refusal is mapped where the launch is called, so an older desktop reads as one.", 170 * seconds),
    done(
      "agent-mesh",
      "It is mapped in tailnet-mesh-service.ts, createConversation: an \"Unknown tool\" answer becomes `unsupported`, which the phone answers by asking for a Studio update.",
      141 * seconds,
    ),
    event("subagent_status", { toolUseId: "agent-mesh", status: "completed", usage: { totalTokens: 20_000, toolUses: 2, durationMs: 89_000 } }, 141 * seconds),
    // Failed.
    ...lane("agent-tests", "general-purpose", "Run the gateway tests", 120 * seconds),
    step("tests-run", "agent-tests", "Bash", { command: "npx vitest run gateway" }, 118 * seconds),
    done("tests-run", "Exit code 1", 112 * seconds, { parentToolUseId: "agent-tests", status: "error", isError: true, exitCode: 1 }),
    event("tool_output", { toolUseId: "agent-tests", output: "vitest exited with 1", status: "error", isError: true, backgroundResult: true }, 111 * seconds),
    event("subagent_status", { toolUseId: "agent-tests", status: "failed", error: "vitest exited with 1", usage: { totalTokens: 5_000, toolUses: 1, durationMs: 9_000 } }, 111 * seconds),
    // Working: a background agent's launch notice is for the model, not shown.
    ...lane("agent-gateway", "Explore", "Map the gateway's conversation tools", 42 * seconds),
    done("agent-gateway", "Async agent launched successfully. agentId: a1", 42 * seconds),
    said("agent-gateway", "Starting with the gateway's tool table, then the launch service it calls.", 41 * seconds),
    step("gw-grep", "agent-gateway", "Grep", { pattern: "conversation\\.create" }, 39 * seconds),
    done("gw-grep", "4 hits", 38 * seconds, { parentToolUseId: "agent-gateway" }),
    step("gw-read-1", "agent-gateway", "Read", { path: "src/main/studio-gateway-tools.ts" }, 35 * seconds),
    done("gw-read-1", "…", 34 * seconds, { parentToolUseId: "agent-gateway" }),
    step("gw-read-2", "agent-gateway", "Read", { path: "src/main/conversation-launch-service.ts" }, 30 * seconds),
    done("gw-read-2", "…", 29 * seconds, { parentToolUseId: "agent-gateway" }),
    said("agent-gateway", "The tool returns once the session is up, without waiting for the reply, so a phone can subscribe right after.", 25 * seconds),
    step("gw-read-3", "agent-gateway", "Read", { path: "src/main/tailnet-scopes.ts" }, 22 * seconds),
    done("gw-read-3", "…", 21 * seconds, { parentToolUseId: "agent-gateway" }),
    step("gw-read-4", "agent-gateway", "Read", { path: "src/main/conversation-tools.ts" }, 8 * seconds),
    event("subagent_status", { toolUseId: "agent-gateway", status: "running", background: true, progressSummary: "reading conversation-tools.ts", usage: { totalTokens: 12_000, toolUses: 7, durationMs: 0 } }, 7 * seconds),
    ...lane("agent-scopes", "Plan", "Check the scopes a phone's grant carries", 18 * seconds),
    done("agent-scopes", "Async agent launched successfully. agentId: a2", 18 * seconds),
    event("subagent_status", { toolUseId: "agent-scopes", status: "running", background: true, lastToolName: "Grep", usage: { totalTokens: 8_000, toolUses: 2, durationMs: 0 } }, 5 * seconds),
  ];
}

// The approvals a plan-mode turn stops on.
function planTurn(): ConversationEvent[] {
  const turn = { turnId: "turn-one" };
  return [
    event("user_message", { ...turn, text: "Plan how the phone pairs from a link instead of a QR code." }, 3 * minutes),
    event("turn_started", turn, 3 * minutes),
    ...["mobilePairing.ts", "pairingPayload.ts", "PairingScreen.tsx"].flatMap((file, index) => [
      tool(`read-${index}`, "Read", { path: `src/features/pairing/${file}` }, (170 - index) * seconds),
      done(`read-${index}`, "…", (169 - index) * seconds),
    ]),
    tool("grep", "Grep", { pattern: "sprintengine-tailnet" }, 160 * seconds),
    done("grep", "2 hits", 159 * seconds),
    event("approval_requested", {
      ...turn,
      requestId: "approve-read",
      kind: "tool",
      action: "Read",
      summary: "Read app.json",
      input: { path: "app.json" },
    }, 150 * seconds),
    event("approval_requested", {
      ...turn,
      requestId: "choose",
      kind: "question",
      questions: [
        {
          question: "Should a stale link offer the QR code instead?",
          options: [{ label: "Offer the QR code" }, { label: "Just say why" }],
          allowFreeText: true,
        },
      ],
    }, 140 * seconds),
    event("approval_requested", {
      ...turn,
      requestId: "plan",
      kind: "plan",
      plan:
        "# Pair by sprintengine-tailnet link\n\nThe desktop mints a one-time link; the phone opens it from any messenger and finishes pairing without the camera.\n\n1. Register the `sprintengine-tailnet` scheme on Android and iOS.\n2. Parse and validate the link in mobilePairing.ts.\n3. Reuse the QR path's handshake from there.\n4. Say why a stale link fails.\n\n## Tests\n\n- A link with a spent code says so.\n- A link for another desktop is refused.",
    }, 120 * seconds),
  ];
}

// The green row's chat, opened: a turn read on the desktop before its visit,
// then one that finished after it, which the "New" divider stands above and
// the chat opens onto.
function docsTurns(): ConversationEvent[] {
  const owner = verifyUnseenConversation;
  const said = (turnId: string, type: string, payload: Record<string, unknown>, agoMs: number) =>
    event(type, { turnId, ...payload }, agoMs, owner);
  const step = (turnId: string, id: string, name: string, input: Record<string, unknown>, agoMs: number) => [
    said(turnId, "tool_started", { toolUseId: id, name, input }, agoMs),
    said(turnId, "tool_output", { toolUseId: id, output: "…", status: "ok" }, agoMs - 20 * seconds),
  ];
  return [
    said("turn-rules", "user_message", { text: "Write down the chat list's rules: what tints a row, and what moves it." }, 34 * minutes),
    said("turn-rules", "turn_started", {}, 34 * minutes),
    ...step("turn-rules", "rules-read", "Read", { path: "src/features/conversations/conversationListLogic.ts" }, 33 * minutes),
    ...step("turn-rules", "rules-edit", "Edit", { path: "docs/conversations.md" }, 32 * minutes),
    said(
      "turn-rules",
      "content_delta",
      {
        text:
          "The list's rules are in **docs/conversations.md** now, under The list.\n\n" +
          "- **Order.** Chats go by when you last wrote in each, newest first, and a group by its most recently written chat.\n" +
          "- **Tints.** Gold while an approval or a question waits on you; green when a turn finished in the last day that nobody has seen since.\n" +
          "- **Nothing moves a row** but your own message: finishing a turn or starting to wait only tints it.\n" +
          "- **Earlier** holds the chats at rest last written in more than a day ago. A chat waiting on you never goes there.\n\n" +
          "I left the visit clocks for a section of their own, since they are what makes a turn news.",
      },
      31 * minutes,
    ),
    said("turn-rules", "turn_completed", { durationMs: 3 * minutes }, 30 * minutes),
    said("turn-earlier", "user_message", { text: "Say why a waiting chat never goes under Earlier." }, 20 * minutes),
    said("turn-earlier", "turn_started", {}, 20 * minutes),
    ...step("turn-earlier", "earlier-edit", "Edit", { path: "docs/conversations.md" }, 15 * minutes),
    said(
      "turn-earlier",
      "content_delta",
      {
        text:
          "Added it: a chat asking for something stays in view however long ago you wrote in it, because it cannot move on until you answer. " +
          "The same paragraph says a working chat stays out of Earlier too, since it is not at rest.",
      },
      13 * minutes,
    ),
    said("turn-earlier", "turn_completed", { durationMs: 8 * minutes }, 12 * minutes),
  ];
}

// The failed row's chat, opened: a test run that would not pass, and the turn
// stopping on it.
function flakyTurn(): ConversationEvent[] {
  const owner = verifyFailedConversation;
  const turnId = "turn-flaky";
  return [
    event("user_message", { turnId, text: "The pairing test fails one run in five. Find out why and fix it." }, 2 * 60 * minutes + 10 * minutes, owner),
    event("turn_started", { turnId }, 2 * 60 * minutes + 10 * minutes, owner),
    event("tool_started", { turnId, toolUseId: "flaky-read", name: "Read", input: { path: "src/features/pairing/mobilePairing.regression.test.js" } }, 2 * 60 * minutes + 9 * minutes, owner),
    event("tool_output", { turnId, toolUseId: "flaky-read", output: "…", status: "ok" }, 2 * 60 * minutes + 9 * minutes, owner),
    event("tool_started", { turnId, toolUseId: "flaky-run", name: "Bash", input: { command: "npm run test:mobile" } }, 2 * 60 * minutes + 6 * minutes, owner),
    event("tool_output", { turnId, toolUseId: "flaky-run", output: "Exit code 1\n1 failing", status: "error", isError: true, exitCode: 1 }, 2 * 60 * minutes + 1 * minutes, owner),
    event("turn_failed", { turnId, message: "The model's usage limit was reached. Try again after it resets." }, 2 * 60 * minutes, owner),
  ];
}

/** The fixture's events, as another chat on the same desktop would send them. */
const retarget = (events: ConversationEvent[], owner: ConversationThread): ConversationEvent[] =>
  events.map((entry) => ({ ...entry, workspaceId: owner.workspaceId, agentId: owner.agentId, sessionId: owner.sessionId! }));

// What the settled turn changed, as `git diff` writes each file.
const turnPatches: Record<string, { status: "added" | "modified" | "deleted"; patch: string }> = {
  "src/components/Toast.tsx": {
    status: "modified",
    patch: [
      "diff --git a/src/components/Toast.tsx b/src/components/Toast.tsx",
      "index 3f1c2a4..8b0d9e1 100644",
      "--- a/src/components/Toast.tsx",
      "+++ b/src/components/Toast.tsx",
      '@@ -4,8 +4,14 @@ import { useTheme } from "../theme/ThemeProvider";',
      ' import { toastStore, type ToastTone } from "./toastStore";',
      ' import { HOLD_MS } from "./toastTimers";',
      " ",
      "-// Neutral and success toasts leave on their own; warn and error stay until dismissed.",
      "-const AUTO_DISMISS_MS = 5_000;",
      "+// Every toast leaves on its own, like the desktop's: warn and error hold",
      "+// twice as long, since they are the ones a person needs time to read.",
      "+export const AUTO_DISMISS_MS: Record<ToastTone, number> = {",
      "+  neutral: 5_000,",
      "+  success: 5_000,",
      "+  warn: 10_000,",
      "+  error: 10_000,",
      "+};",
      " ",
      " export function Toast({ id, tone, message }: { id: string; tone: ToastTone; message: string }) {",
      "   const { colors } = useTheme();",
      "@@ -38,11 +44,11 @@ export function Toast({ id, tone, message }: { id: string; tone: ToastTone; messa",
      "   const [held, setHeld] = useState(false);",
      " ",
      "   useEffect(() => {",
      '-    if (held || tone === "warn" || tone === "error") return;',
      "-    const timer = setTimeout(() => toastStore.dismiss(id), AUTO_DISMISS_MS);",
      "+    if (held) return;",
      "+    const timer = setTimeout(() => toastStore.dismiss(id), AUTO_DISMISS_MS[tone]);",
      "     return () => clearTimeout(timer);",
      "   }, [held, id, tone]);",
      " ",
      "-  const onPressIn = () => setHeld(true);",
      "+  const onPressIn = () => { holdTimer.current = setTimeout(() => setHeld(true), HOLD_MS); };",
      "   const onPressOut = () => setHeld(false);",
      "   return (",
      "",
    ].join("\n"),
  },
  "src/components/toastTimers.ts": {
    status: "added",
    patch: [
      "diff --git a/src/components/toastTimers.ts b/src/components/toastTimers.ts",
      "new file mode 100644",
      "index 0000000..5d1e2f3",
      "--- /dev/null",
      "+++ b/src/components/toastTimers.ts",
      "@@ -0,0 +1,6 @@",
      "+// How long a press must rest on a toast before it counts as holding it:",
      "+// shorter, and a tap that meant to dismiss would pause it instead.",
      "+export const HOLD_MS = 180;",
      "+",
      "+/** A toast's clock, paused while held. */",
      "+export const remaining = (total: number, elapsed: number) => Math.max(0, total - elapsed);",
      "",
    ].join("\n"),
  },
  "src/components/toastQueue.ts": {
    status: "deleted",
    patch: [
      "diff --git a/src/components/toastQueue.ts b/src/components/toastQueue.ts",
      "deleted file mode 100644",
      "index 7a6b5c4..0000000",
      "--- a/src/components/toastQueue.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@",
      "-// Superseded by toastStore: one queue, one clock.",
      "-export const queue: string[] = [];",
      "-export const push = (id: string) => queue.push(id);",
      "-export const clear = () => queue.splice(0);",
      "",
    ].join("\n"),
  },
};
const lineCount = (patch: string, sign: "+" | "-") =>
  patch.split("\n").filter((line) => line.startsWith(sign) && !line.startsWith(`${sign}${sign}${sign} `)).length;
const turnFiles = Object.entries(turnPatches).map(([path, { status, patch }]) => ({
  path,
  status,
  addedLines: lineCount(patch, "+"),
  removedLines: lineCount(patch, "-"),
  binary: false,
}));
/** A `getTurnDiff` answer for any checkpointed turn: its files, or one file's patch. */
function turnDiffAnswer(path?: string) {
  if (path === undefined) return { ok: true, diff: { files: turnFiles, submodulesExcluded: true } };
  const entry = turnPatches[path];
  if (!entry) return { ok: false, message: "File is not part of this turn." };
  return { ok: true, diff: { files: turnFiles, submodulesExcluded: true }, patch: entry.patch };
}

// The rich chat's two turns. The person's own message holds a fence and
// dollars too: it stays the text they wrote.
function richTurns(): ConversationEvent[] {
  const owner = verifyRichConversation;
  const said = (turnId: string, type: string, payload: Record<string, unknown>, agoMs: number) =>
    event(type, { turnId, ...payload }, agoMs, owner);
  const day = 24 * 60 * minutes;
  return [
    said(
      "rich-one",
      "user_message",
      {
        text:
          "Draw the pairing flow and the chat's handshake, and give me the reconnect backoff as a formula. " +
          "(What I type stays as I typed it: $$x^2$$ and\n```mermaid\nflowchart TD\n  A --> B\n```)",
      },
      3 * day + 5 * minutes,
    ),
    said("rich-one", "turn_started", {}, 3 * day + 5 * minutes),
    said(
      "rich-one",
      "content_delta",
      {
        text: [
          "Here is the pairing flow:",
          "",
          "```mermaid",
          "flowchart TD",
          "  Scan[Scan the square] --> Name{Name the desktop?}",
          "  Name -->|Yes| Spend[Spend the one-time code]",
          "  Name -->|No| Stop[Nothing is sent]",
          "  Spend --> Paired[Paired over the tailnet]",
          "```",
          "",
          "And the chat's handshake when it reconnects:",
          "",
          "```mermaid",
          "sequenceDiagram",
          "  participant Phone",
          "  participant Desktop",
          "  Phone->>Desktop: conversation.open (afterSeq 41)",
          "  Desktop-->>Phone: events 42 to 57",
          "  Note over Phone,Desktop: live",
          "  Phone->>Desktop: conversation.visit",
          "```",
          "",
          "Attempt \\(n\\) waits, with base \\(b\\) and a jitter \\(\\epsilon\\):",
          "",
          "$$",
          "t_n = \\min\\left(t_{\\max},\\; b \\cdot 2^{n}\\right)(1 + \\epsilon), \\quad \\epsilon \\sim U(0, 0.2)",
          "$$",
          "",
          "so the expected number of retries over a day is",
          "\\[ \\mathbb{E}[N] = \\sum_{k=0}^{\\infty} P(N > k) \\]",
          "",
          "and a ```math fence draws the same way:",
          "",
          "```math",
          "\\begin{pmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{pmatrix}",
          "```",
          "",
          "In bash `$$` is the shell's PID, and the plan costs $5 to $10 a month: neither is math. " +
            "The backoff follows \\[1\\], and the flag stays \\[WIP\\] for now.",
          "",
          "The paper's preamble stays code, as written:",
          "",
          "```latex",
          "\\documentclass{article}",
          "\\begin{document}",
          "\\[ E = mc^2 \\]",
          "\\end{document}",
          "```",
        ].join("\n"),
      },
      3 * day + 4 * minutes,
    ),
    said("rich-one", "turn_completed", { durationMs: 60_000 }, 3 * day + 4 * minutes),
    said("rich-two", "user_message", { text: "And the ones that cannot be drawn?" }, 3 * day + 2 * minutes),
    said("rich-two", "turn_started", {}, 3 * day + 2 * minutes),
    said(
      "rich-two",
      "content_delta",
      {
        text: [
          "This one has a typo, so it shows as source with Mermaid's complaint:",
          "",
          "```mermaid",
          "flowchart TD",
          "  A[Start] -->",
          "```",
          "",
          "This one asks for a picture from the web, which a reply may not load:",
          "",
          "```mermaid",
          "flowchart TD",
          '  A@{ img: "https://example.com/logo.png", label: "Logo" } --> B',
          "```",
          "",
          "And this formula does not parse:",
          "",
          "$$",
          "\\frac{1}{",
          "$$",
        ].join("\n"),
      },
      3 * day + minutes,
    ),
    said("rich-two", "turn_completed", { durationMs: 30_000 }, 3 * day),
  ];
}

// Studio's two kinds of message, between the person's: an agent the chat
// launched reports back, and a turn stopped by a usage limit resumes once the
// limit resets. Their words open with Studio's name, as the agent reads them;
// the row says the name itself and leaves that out.
function noticesTurns(): ConversationEvent[] {
  const owner = verifyNoticesConversation;
  const said = (turnId: string, type: string, payload: Record<string, unknown>, agoMs: number) =>
    event(type, { turnId, ...payload }, agoMs, owner);
  const day = 24 * 60 * minutes;
  return [
    said("notices-launch", "user_message", { text: "Launch an agent to audit the pairing flow, and tell me what it finds." }, 2 * day + 50 * minutes),
    said("notices-launch", "turn_started", {}, 2 * day + 50 * minutes),
    said(
      "notices-launch",
      "content_delta",
      { text: "I launched **pairing-audit** to read the pairing flow end to end. I'll pick its findings up when it reports back." },
      2 * day + 49 * minutes,
    ),
    said("notices-launch", "turn_completed", { durationMs: 2 * minutes }, 2 * day + 48 * minutes),
    said(
      "notices-news",
      "user_message",
      {
        text:
          '[SprintEngine Studio] Agent pairing-audit, which you launched, finished its turn. It last said: "The pairing code is checked twice; ' +
          'the second check can go." (workspaceId "ws-audit", agentId "agent-audit")',
        origin: { kind: "studio", reason: "agent-notice" },
      },
      2 * day + 25 * minutes,
    ),
    said("notices-news", "turn_started", {}, 2 * day + 25 * minutes),
    said(
      "notices-news",
      "content_delta",
      { text: "pairing-audit is done. The pairing code is checked once when the link opens and again before the handshake; the second check adds nothing." },
      2 * day + 24 * minutes,
    ),
    said("notices-news", "turn_completed", { durationMs: minutes }, 2 * day + 24 * minutes),
    said("notices-drop", "user_message", { text: "Drop the second check and run the pairing tests." }, 2 * day + 15 * minutes),
    said("notices-drop", "turn_started", {}, 2 * day + 15 * minutes),
    said("notices-drop", "tool_started", { toolUseId: "notices-edit", name: "Edit", input: { path: "src/features/pairing/mobilePairing.ts" } }, 2 * day + 14 * minutes),
    said("notices-drop", "tool_output", { toolUseId: "notices-edit", output: "Updated", status: "ok" }, 2 * day + 14 * minutes),
    said("notices-drop", "turn_failed", { message: "The model's usage limit was reached. Try again after it resets." }, 2 * day + 13 * minutes),
    said(
      "notices-resume",
      "user_message",
      {
        text: "[SprintEngine Studio] Continue where you left off — your usage limit has reset.",
        origin: { kind: "studio", reason: "usage-resume" },
      },
      2 * day + 2 * minutes,
    ),
    said("notices-resume", "turn_started", {}, 2 * day + 2 * minutes),
    said("notices-resume", "tool_started", { toolUseId: "notices-test", name: "Bash", input: { command: "npm run test:mobile" } }, 2 * day + 90 * seconds),
    said("notices-resume", "tool_output", { toolUseId: "notices-test", output: "All tests passed", status: "ok", exitCode: 0 }, 2 * day + minutes),
    said("notices-resume", "content_delta", { text: "Picked up where I stopped: the second check is gone, and the pairing tests pass." }, 2 * day + 30 * seconds),
    said("notices-resume", "turn_completed", { durationMs: 2 * minutes }, 2 * day),
  ];
}

// The person's message with four files attached by path, beside its words.
function filesTurns(): ConversationEvent[] {
  const owner = verifyFilesConversation;
  const said = (turnId: string, type: string, payload: Record<string, unknown>, agoMs: number) =>
    event(type, { turnId, ...payload }, agoMs, owner);
  const day = 24 * 60 * minutes;
  return [
    said(
      "files-compare",
      "user_message",
      {
        text: "Compare the quarter's numbers against the plan, and say where they part.",
        files: [
          { path: "/Users/dev/Documents/Quarterly report final v3 (reviewed).pdf" },
          { path: "C:\\Users\\dev\\Documents\\Pairing plan.docx" },
          { path: "\\\\build-box\\share\\finance\\Budget 2026.xlsx" },
          { path: "/Users/dev/Downloads/session-capture.trace" },
        ],
      },
      2 * day + 55 * minutes,
    ),
    said("files-compare", "turn_started", {}, 2 * day + 55 * minutes),
    said("files-compare", "tool_started", { toolUseId: "files-read", name: "Read", input: { path: "/Users/dev/Documents/Quarterly report final v3 (reviewed).pdf" } }, 2 * day + 54 * minutes),
    said("files-compare", "tool_output", { toolUseId: "files-read", output: "…", status: "ok" }, 2 * day + 53 * minutes),
    said(
      "files-compare",
      "content_delta",
      { text: "They part in one place: the quarter spent 12% more on hosting than the budget planned, which the plan puts down to the pairing relay." },
      2 * day + 51 * minutes,
    ),
    said("files-compare", "turn_completed", { durationMs: 5 * minutes }, 2 * day + 50 * minutes),
  ];
}

/** The streaming chat's reply, in the pieces it arrives in. */
const RICH_LIVE_PIECES = [
  "The phone's side of it, ",
  "drawn as it arrives:\n\n```mer",
  "maid\nflowchart LR\n  Phone -->|opens| ",
  "Desktop\n  Desktop -->|streams| Phone\n",
  "```",
  "\n\nand the sum, once its closing line is in:\n\n$$\n\\sum_{i=1}^{n} i = ",
  "\\frac{n(n+1)}{2}\n",
  "$$",
  "\n\nThat's all of it.",
];

// Every picture in the fixture is this one, bundled: the harness never
// reaches for a desktop.
const fixturePicture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAACACAIAAADS5vE8AAAC8klEQVR42u3dSWpbURCG0beUrDCLyJqygfRO4iZ93+7Ak0wyiuBhISFQ7Ctjv7/qwDcWpupQV2Cwp7/nv6XhJiPQgYB+ScMBJIAEkHIB/ZSGA0gACSDlAvohDQeQABJAygX0XRoOIAEkgJQL6Js0HEACSAApF9BXaTiAtjq/f/cyGRRAVxPDE0D/cfPn3p2rRtIM6EurDkRzGUyt5jk1pHONbvZIAggdjNoDunk63RitAH2u2i3S2WVUdchTYTpL0LNzigCih6HCgBZIp/ZztgL0qUwL17NtqMjMJ3oYAihJTzFDEz0MHQjoY3SherYNBc9/oochgAACqKWeAoZWgD4kVkbPtqG8RQQDKqNnbQgg56fdEZqcH0foQEDvsyp5fraPUNI6IgGV1LNxhAByftococn5cYQOBPQupfLnZ/sIZSwFIIA6ASqvZ+MVA8j5aXCEVoDeRtQSUMBeAAKoDaAmeja+BgEEUANAb5Zfq/dr+xVb+moAAggggAACKBfQ6+XXGNDSVwMQQAABBBBAuYBeLb/GgJa+GoAAAggggADKBXS2/BoDWvpqMgDNhvr9Nv4MIIAA8op5v/YCOo2oJaCAvQAEUA9As6FOX4BOAXKEip+fGdBJSs0AZSwlCdBsqMf7dQKQI1T//OQBKn+EsvTMgI6zavA3EpPWkQdoNlT3/BwD5Ah1OT+pgEoeoUQ9M6CXiRX9Xxl5i0gFVMlQrp5sQDUMResBCKBrAPQiuhL/MzV4/vGAcg0V0FMEUKKhGnrqAMoyVEbPDOh5mSIMXegpMvNSgJZvqJiegoDWhpbGaP1TFZt2QUALNFRVzwzoqGoLMXRBp+aQKwNaG7otRhuH5wggjNDpCugmGfWhswb0rFXrBV+vpM2PbTXPdoB2GQ1j2v2QhpNsCmiPpIE6D7A7oDFPBrUJ6Kk0HEACSAApF9ATaTiABJAAUi6gx9JwAAkgAaRcQI+k4QASQAJIuYAeSsMBJIAEkHIBPZCGA0gH9Q87Fs/tK5+fvwAAAABJRU5ErkJggg==";

/** One chat on the fake desktop: what it holds, whether its turn is open, and the requests it waits on. */
interface FakeChat {
  owner: ConversationThread;
  history: ConversationEvent[];
  turnOpen: boolean;
  pending: number;
  /** A reply replayed in these pieces the first time the chat is opened. */
  replay?: string[];
  /** What the desktop holds for the chat until its turn ends. */
  desktopHeld: ConversationQueuedMessage[];
}
const fakeChats = new Map<string, FakeChat>();
/**
 * A chat's state, made the first time it is opened. The fixture chat holds the
 * scenario's turns; the green row's chat its two; the gold row's chat the
 * plan turn's requests; the failed row's chat its failed turn; any other is
 * the fixture chat's history again, as before.
 */
function fakeChat(workspaceId: string): FakeChat {
  const known = fakeChats.get(workspaceId);
  if (known) return known;
  const made = (
    workspaceId === verifyRichConversation.workspaceId
      ? { owner: verifyRichConversation, history: richTurns(), turnOpen: false, pending: 0 }
      : workspaceId === verifyRichLiveConversation.workspaceId
      ? {
          owner: verifyRichLiveConversation,
          history: [
            event("user_message", { turnId: "rich-live", text: "Show me the flow again, and the sum." }, 2 * minutes, verifyRichLiveConversation),
          ],
          turnOpen: false,
          pending: 0,
          replay: RICH_LIVE_PIECES,
        }
      : workspaceId === verifyNoticesConversation.workspaceId
      ? { owner: verifyNoticesConversation, history: noticesTurns(), turnOpen: false, pending: 0 }
      : workspaceId === verifyFilesConversation.workspaceId
      ? { owner: verifyFilesConversation, history: filesTurns(), turnOpen: false, pending: 0 }
      : workspaceId === verifyUnseenConversation.workspaceId
      ? { owner: verifyUnseenConversation, history: docsTurns(), turnOpen: false, pending: 0 }
      : workspaceId === verifyWaitingConversation.workspaceId
        ? { owner: verifyWaitingConversation, history: retarget(planTurn(), verifyWaitingConversation), turnOpen: true, pending: 3 }
        : workspaceId === verifyFailedConversation.workspaceId
          ? { owner: verifyFailedConversation, history: flakyTurn(), turnOpen: false, pending: 0 }
          : workspaceId === verifyConversation.workspaceId
        ? {
            owner: verifyConversation,
            history:
              scenario === "plan" ? planTurn() : scenario === "idle" ? settledTurn() : [...settledTurn(), ...workingTurn()],
            turnOpen: scenario !== "idle",
            pending: 3,
          }
        : fakeChat(verifyConversation.workspaceId)
  ) as FakeChat;
  made.desktopHeld ??=
    scenario === "queued-failed" && made.owner === verifyConversation
      ? [
          {
            id: "held-refused",
            text: "Run the gateway tests again once the mesh is up.",
            createdAt: at(12 * minutes),
            failure: "The chat's session stopped before this could be sent.",
          },
        ]
      : [];
  fakeChats.set(workspaceId, made);
  return made;
}
let listener: ConversationStreamHandlers | null = null;
let counter = 0;
/** Every chat the fake desktop holds, as its records have them. */
function fakeListed(): ConversationThread[] {
  return [
    verifyConversation,
    verifyUnseenConversation,
    verifyWaitingConversation,
    verifyFailedConversation,
    verifyLocalConversation,
    verifySettledConversation,
    verifyRichConversation,
    verifyRichLiveConversation,
    verifyNoticesConversation,
    verifyFilesConversation,
  ];
}
export const fakeConversationsApi: ConversationApi = {
  async list() {
    return (
      fakeListed()
        // A chat settled from the phone leaves the desktop's list, as a real
        // one's does; the first settled chat stays listed on purpose (above).
        .filter(
          (thread) =>
            thread.workspaceId === verifySettledConversation.workspaceId || !verifySettledAt.has(thread.workspaceId),
        )
        // The fake's own clock, where it has stamped or marked the chat: a
        // visit only moves it forward and a mark unread back, as on the desktop.
        .map((thread) => {
          const visited = visitedAt.get(thread.workspaceId);
          const wakeAt = snoozedUntil.get(thread.workspaceId);
          const listed = visited !== undefined ? { ...thread, lastVisitedAt: visited } : thread;
          // Only a snooze still ahead is listed, as the desktop lists one.
          return wakeAt !== undefined && wakeAt > Date.now() ? { ...listed, snoozedUntil: wakeAt } : listed;
        })
    );
  },
  open(key, _afterSeq, handlers, options) {
    listener = handlers;
    const chat = fakeChat(key.workspaceId);
    const { history, owner } = chat;
    // What this desktop holds for the chat, told to a stream that watches.
    const tellHeld = () => {
      if (options?.queuedSends && listener === handlers)
        handlers.onFrame({ type: "queued", key, messages: chat.desktopHeld.map((message) => ({ ...message })) });
    };
    queueMicrotask(() => {
      if (listener !== handlers) return;
      handlers.onState("synchronizing");
      handlers.onFrame({
        type: "snapshot",
        page: { events: history, hasMore: false, beforeCursor: null },
      });
      handlers.onFrame({ type: "synchronized", seq: sequence });
      handlers.onState("live");
      tellHeld();
    });
    const publish = (entry: ConversationEvent) => {
      history.push(entry);
      handlers.onFrame({ type: "event", event: entry });
    };
    // The streaming chat's reply, a piece every 0.9 s once the chat is live,
    // with a longer pause where a block has just closed on the last line.
    const replay = chat.replay;
    if (replay) {
      chat.replay = undefined;
      const turnId = "rich-live-reply";
      const steps: (() => ConversationEvent)[] = [
        () => event("turn_started", { turnId }, 0, owner),
        ...replay.map((text) => () => event("content_delta", { turnId, text }, 0, owner)),
        () => event("turn_completed", { turnId, durationMs: replay.length * 900 }, 0, owner),
      ];
      const next = (index: number) => {
        if (index >= steps.length) return;
        // Left before it finished: the rest is in the chat's history when it opens again.
        if (listener !== handlers) {
          for (const step of steps.slice(index)) history.push(step());
          return;
        }
        publish(steps[index]());
        const closedOnLastLine = /(```|\$\$)$/.test(replay[index - 1] ?? "");
        setTimeout(() => next(index + 1), closedOnLastLine ? 2_500 : 900);
      };
      setTimeout(() => next(0), 1_500);
    }
    // A send made while a turn runs waits for it to end, as the real stream's
    // outbox holds it: that is what keeps the queued bubble on screen.
    const held: { commandId: string; message: string }[] = [];
    const reply = (commandId: string, message: string) => {
      publish(event("user_message", { turnId: commandId, text: message, commandId }, 0, owner));
      publish(event("turn_started", { turnId: commandId }, 0, owner));
      publish(
        event(
          "content_delta",
          {
            turnId: commandId,
            text: "The search changes are ready. All regression tests pass.",
          },
          0,
          owner,
        ),
      );
      publish(event("turn_completed", { turnId: commandId, durationMs: 4_000 }, 0, owner));
    };
    const endTurn = (type: "turn_completed" | "turn_failed") => {
      chat.turnOpen = false;
      publish(
        event(
          type,
          { turnId: "turn-one", ...(type === "turn_failed" ? { message: "Interrupted" } : { checkpointAvailable: true, checkpointTurnSeq: 1 }) },
          0,
          owner,
        ),
      );
      for (const send of held.splice(0)) reply(send.commandId, send.message);
      // The desktop sends what it holds as the turn ends; a refused one waits.
      const going = chat.desktopHeld.filter((message) => message.failure === undefined);
      chat.desktopHeld = chat.desktopHeld.filter((message) => message.failure !== undefined);
      tellHeld();
      for (const message of going) reply(`held-${message.id}`, message.text);
    };
    return {
      command(command, suppliedId?: string) {
        const commandId = suppliedId ?? `fixture-command-${++counter}`;
        queueMicrotask(() => {
          if (command.kind === "resolveApproval" || command.kind === "answerQuestion" || command.kind === "resolvePlan") {
            publish(
              event("approval_resolved", {
                requestId: command.requestId,
                approved:
                  command.kind === "answerQuestion" ||
                  (command.kind === "resolvePlan" ? command.decision === "approve" : command.decision !== "deny"),
              }, 0, owner),
            );
            if (--chat.pending === 0) endTurn("turn_completed");
          } else if (command.kind === "interrupt") {
            if (chat.turnOpen) endTurn("turn_failed");
          } else if (command.kind === "stopSubagent") {
            publish(event("subagent_status", { toolUseId: command.toolUseId, status: "stopped" }, 0, owner));
          } else if (command.kind === "cancelQueued") {
            const before = chat.desktopHeld.length;
            chat.desktopHeld = chat.desktopHeld.filter((message) => message.id !== command.queuedId);
            if (chat.desktopHeld.length === before) {
              handlers.onFrame({
                type: "commandResult",
                commandId,
                ok: false,
                message: "That message is no longer queued: it was sent or taken back.",
              });
              return;
            }
            tellHeld();
          } else if (command.kind === "send" && command.steer && chat.turnOpen) {
            publish(event("user_message", { turnId: "turn-one", text: command.message, commandId }, 0, owner));
          } else if (command.kind === "send" && command.queue && options?.queuedSends) {
            if (!chat.turnOpen) reply(commandId, command.message);
            else {
              // Joined with what else this turn has queued, as the desktop does.
              const words = command.message.trim();
              const joined = chat.desktopHeld.find((message) => message.failure === undefined);
              if (joined) joined.text = `${joined.text}\n${words}`;
              else chat.desktopHeld.push({ id: `held-${++counter}`, text: words, createdAt: Date.now() });
              tellHeld();
            }
          } else if (command.kind === "send") {
            if (chat.turnOpen) {
              held.push({ commandId, message: command.message });
              return;
            }
            reply(commandId, command.message);
          }
          handlers.onFrame({ type: "commandResult", commandId, ok: true });
        });
        return commandId;
      },
      request(frame) {
        const requestId = `fixture-request-${++counter}`;
        queueMicrotask(() =>
          handlers.onFrame({
            type: "result",
            requestId,
            ok: true,
            data:
              frame.type === "getToolDetail" && "toolUseId" in frame && typeof frame.toolUseId === "string"
                ? fixtureToolDetail(history, frame.toolUseId)
                : frame.type === "getTurnDiff"
                  ? turnDiffAnswer("path" in frame && typeof frame.path === "string" ? frame.path : undefined)
                  : { ok: false, message: "Not in the fixture." },
          }),
        );
        return requestId;
      },
      cancelPending(commandId) {
        const index = held.findIndex((send) => send.commandId === commandId);
        if (index >= 0) held.splice(index, 1);
      },
      foreground() {},
      retry() {},
      close() {
        if (listener === handlers) listener = null;
      },
    };
  },
  async uploadImage() {
    return "fixture-upload";
  },
  async uploadFile() {
    return "fixture-file-upload";
  },
  imageSource() {
    return { uri: fixturePicture };
  },
  async imageProblem() {
    return "gone";
  },
};

const ESC = "\u001b";
// What the settled turn's failing test run printed, colours and all: long
// enough that a closed step shows its tail and "Show all".
const TEST_RUN_OUTPUT = [
  "> @sprintengine/mobile@0.1.0 test:mobile",
  "> tsc -p tsconfig.test.json && node --test",
  "",
  ...Array.from({ length: 24 }, (_, index) => `${ESC}[32m✔${ESC}[39m toast ${index + 1} clears itself on its own clock ${ESC}[90m(0.${(index * 7) % 9 + 1}ms)${ESC}[39m`),
  `${ESC}[31m✖${ESC}[39m warn toasts clear after ten seconds ${ESC}[90m(1.2ms)${ESC}[39m`,
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "",
  `  ${ESC}[32m10000${ESC}[39m !== ${ESC}[31m5000${ESC}[39m`,
  "",
  "      at src/components/toastStore.regression.test.js:41:10",
  `${ESC}[1mℹ tests 25${ESC}[22m`,
  `${ESC}[32mℹ pass 24${ESC}[39m`,
  `${ESC}[31mℹ fail 1${ESC}[39m`,
].join("\n");

/**
 * What `getToolDetail` answers for a step of the fixture's chats: the whole
 * output a real desktop keeps, shaped per kind, so an opened step shows the
 * phone's reading of each (a command's terminal text, an edit's change, a
 * search's matches, a read's numbered lines).
 */
function fixtureToolDetail(history: ConversationEvent[], toolUseId: string) {
  const started = [...history]
    .reverse()
    .find((entry) => entry.type === "tool_started" && entry.payload?.toolUseId === toolUseId);
  if (!started) return { ok: false, code: "not_found", message: "Tool detail is unavailable." };
  const name = String(started.payload?.name ?? "");
  const input = (started.payload?.input ?? {}) as Record<string, unknown>;
  const detail = (output: unknown, extra: Record<string, unknown> = {}, given: unknown = input) => ({
    ok: true,
    detail: { input: given, output, status: "ok", clipped: false, ...extra },
  });
  if (toolUseId === "test") return detail(TEST_RUN_OUTPUT, { status: "error", exitCode: 1 });
  if (toolUseId === "edit-toast")
    return detail("Updated", {}, {
      file_path: "src/components/Toast.tsx",
      old_string: "export const AUTO_DISMISS_MS = {\n  neutral: 5_000, success: 5_000,\n} as const;\n// Warn and error stay until dismissed.",
      new_string: "export const AUTO_DISMISS_MS = {\n  neutral: 5_000, success: 5_000,\n  warn: 10_000, error: 10_000,\n} as const;",
    });
  if (toolUseId === "edit-store")
    return detail("Updated", {}, {
      file_path: "src/components/toastStore.ts",
      old_string: '  if (tone === "warn" || tone === "error") return;\n  schedule(id, AUTO_DISMISS_MS[tone]);',
      new_string: "  schedule(id, AUTO_DISMISS_MS[tone]);",
    });
  if (name === "Grep")
    return detail(
      [
        "src/main/studio-gateway-tools.ts:212:    case 'conversation.create':",
        "src/main/conversation-launch-service.ts:48:export const CONVERSATION_CREATE = 'conversation.create'",
        "src/main/tailnet-scopes.ts:31:  'conversation.create': 'conversation:operate',",
        "src/renderer/src/api/conversations.ts:77:  return call('conversation.create', input)",
      ].join("\n"),
    );
  if (name === "Read")
    return detail(
      [
        "export const TAILNET_SCOPES = {",
        "  'conversation.list': 'conversation:read',",
        "  'conversation.subscribe': 'conversation:read',",
        "  'conversation.create': 'conversation:operate',",
        "  'conversation.send': 'conversation:operate',",
        "} as const",
        "",
        "export type TailnetScope = (typeof TAILNET_SCOPES)[keyof typeof TAILNET_SCOPES]",
      ]
        .map((line, index) => `${String(index + 1).padStart(6)}→${line}`)
        .join("\n"),
    );
  return detail(started.payload?.output ?? "");
}

/** The messages the harness queues once the chat is live, while its turn runs. */
export const verifyQueuedMessage =
  scenario === "plan" || scenario === "idle"
    ? null
    : ["And once that's clear, draft the phone side too.", "Keep the old queue for desktops without it."];
