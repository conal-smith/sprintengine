import type { ConversationEvent, ConversationThread } from "../../api/conversationWire";
import { presentToolItem, type PresentableTool } from "../../api/conversation-protocol/presentation";
import type { ConversationToolKind } from "../../api/conversation-protocol/tool-types";
import type { MobileSession } from "../../api/types";
import { declaresConversationModels, declaresPermissionModes } from "../../api/tailnetTransport";
import {
  applyAgentReport,
  formatDuration,
  isBackgroundLaunchAck,
  readSubagentStatus,
  type AgentLane,
  type AgentMessage,
  type AgentReport,
} from "./agentLogic";
import { cliForChatProvider, offeredPermissionPresets, PERMISSION_PRESET_OPTIONS } from "./launchLogic";
import { applyContextEvent, type ContextReading } from "./contextUsage";
import { keepUnchanged } from "./keepUnchanged";
import { applyPromptCacheEvent, formatTokenCount, type PromptCacheReading } from "./promptCache";
import { parseAttachedFiles, type AttachedFile } from "./attachedFiles";
import { parseSentImages, type SentImage } from "./sentPhotos";
import { readMessageOrigin, withoutStudioNoticePrefix, type StudioMessageReason } from "./studioNotice";

/**
 * How long the composer's button stays Send after a send, before an empty box
 * lets it turn into Stop.
 */
export const SEND_SETTLE_MS = 1_500;

/**
 * Whether the composer's one button is Send or Stop. It is Stop only when the
 * box is empty, a reply runs that can be stopped, and nothing a finger is in
 * the middle of could have meant Send: not while the microphone listens (its
 * words lag the voice, so the box can be empty under a sentence being said),
 * not while a send waits on it, and not just after a send has emptied the
 * box. A second tap of Send there landed on Stop and broke off the reply the
 * message had just gone to.
 */
export function composerActionKind(input: {
  hasText: boolean;
  stoppable: boolean;
  dictating: boolean;
  sending: boolean;
  justSent: boolean;
}): "send" | "stop" {
  if (input.hasText || !input.stoppable) return "send";
  return input.dictating || input.sending || input.justSent ? "send" : "stop";
}

/** The desktop streams chats. Whether this phone may follow them is `conversationEnabled`'s other half. */
export const conversationOffered = (session: MobileSession) =>
  session.status !== "revoked" && session.tailnetCapabilities?.includes("conversations") === true;
/**
 * The desktop streams chats and this phone's grant may read them: the socket
 * is refused without `conversation:read` (or `operate`, which includes it),
 * and a phone that dialled anyway retried an unexplained close for good.
 */
export const conversationEnabled = (session: MobileSession) =>
  conversationOffered(session) &&
  (session.tailnetScopes.includes("conversation:read") || session.tailnetScopes.includes("conversation:operate"));
export const conversationCanOperate = (session: MobileSession) =>
  conversationEnabled(session) && session.tailnetScopes.includes("conversation:operate");
export type ConversationTarget = { deviceId: string; thread: ConversationThread };
export type ConversationLink = { deviceId: string; workspaceId: string; agentId: string };
/** Links identify a paired desktop; they never carry credentials or a server URL. */
export function parseConversationLink(value: string): ConversationLink | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "sprintengine:" || url.hostname !== "conversation" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3 || parts.some((part) => !part || part.length > 200 || /[\u0000-\u001f]/.test(part))) return null;
    return { deviceId: parts[0], workspaceId: parts[1], agentId: parts[2] };
  } catch { return null; }
}

/**
 * A desktop's own chat link, `sprintengine://chat/<workspaceId>[?agent=<agentId>]`,
 * which its row menu's "Copy link to chat" writes. It names no desktop: the
 * phone looks for the workspace on the desktops it is paired with.
 */
export type ChatLink = { workspaceId: string; agentId: string | null };

// The desktop's grammar (`src/shared/deep-link.ts` there), read the same way:
// an allowlist read by hand rather than by `new URL`, which resolves `..` and
// folds what it cannot read into something it can. A link is untrusted input,
// so it only ever navigates, and its ids are matched against the chats on
// record and go nowhere else.
const MAX_LINK_LENGTH = 2048;
// Every id the desktop mints fits, and nothing that could mean something else
// to a shell or a file system does: no dot, slash, percent, quote or space.
const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;
// scheme :// authority path ? query # fragment, each part taken as written.
const LINK_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/;
// Anything at or below a space, and DEL.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

/** One query parameter's values, as `URLSearchParams.getAll` reads them; null for a value that will not decode. */
function queryValues(query: string, name: string): (string | null)[] {
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part.replace(/\+/g, " "));
    } catch {
      return null;
    }
  };
  return query
    .split("&")
    .filter(Boolean)
    .flatMap((pair) => {
      const at = pair.indexOf("=");
      const key = decode(at < 0 ? pair : pair.slice(0, at));
      return key === name ? [decode(at < 0 ? "" : pair.slice(at + 1))] : [];
    });
}

/**
 * The chat a desktop's chat link names; null for anything else. Scheme and
 * host in any case, one id segment and the trailing slash some browsers add,
 * and the `agent` parameter. Any other parameter is ignored rather than
 * refused, so a link a newer desktop writes still opens its chat; an agent
 * named twice, or not in the id alphabet, is dropped and the chat still opens.
 */
export function parseChatLink(raw: unknown): ChatLink | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LINK_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(raw)) return null;
  const shape = LINK_SHAPE.exec(raw);
  if (!shape) return null;
  const [, scheme = "", authority = "", path = "", query = ""] = shape;
  // A user, password or port makes the authority something other than the bare word.
  if (scheme.toLowerCase() !== "sprintengine" || authority.toLowerCase() !== "chat") return null;
  const segment = /^\/([^/]+)\/?$/.exec(path)?.[1];
  if (!segment || !LINK_ID.test(segment)) return null;
  const agents = queryValues(query, "agent");
  const agent = agents.length === 1 ? agents[0] : null;
  return { workspaceId: segment, agentId: agent && LINK_ID.test(agent) ? agent : null };
}

/** What a `sprintengine://` link opens: a conversation on a named desktop, or a desktop's chat link. */
export type AppLink = { kind: "conversation"; link: ConversationLink } | { kind: "chat"; link: ChatLink };

export function parseAppLink(value: string): AppLink | null {
  const conversation = parseConversationLink(value);
  if (conversation) return { kind: "conversation", link: conversation };
  const chat = parseChatLink(value);
  return chat ? { kind: "chat", link: chat } : null;
}
export type MobileTool = PresentableTool & {
  id: string;
  output?: string;
  /** When the call started, by the desktop's clock: it places an agent's words between its steps. */
  startedAt?: number;
  /** The agent lane this call ran inside, when an agent made it. */
  parentToolUseId?: string;
};
export type PlanStatus = "pending" | "approved" | "denied" | "cancelled";
type ToolsRow = { kind: "tools"; id: string; tools: MobileTool[]; turn?: string };
/** The files one step reported changing, by path, with its line counts where it gave them. */
type StepFileChanges = Map<string, { added?: number; removed?: number }>;
/** What a turn changed on disk: the desktop's checkpoint summary, else the files its steps reported. */
export type TurnChanges = { files: number; addedLines?: number; removedLines?: number };
/** One piece of a folded turn, in the order it happened: a run of steps, what the agent said between them, or what it thought. */
export type FoldPart =
  | { kind: "tools"; id: string; tools: MobileTool[] }
  | { kind: "prose"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string };
/** A provider's retry of a failed model call, as `turn_retrying` reports it. */
export type TurnRetry = { attempt: number; maxAttempts: number; retryInMs: number; error?: string; status?: number; at: number };
type PlanRow = { kind: "plan"; id: string; requestId: string; plan: string; status: PlanStatus };
export type ConversationRow =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      at: number;
      commandId?: string;
      turn?: string;
      /** The files the person attached by path (`attachedFiles.ts`); only a person's message has them. */
      files?: AttachedFile[];
      /** The pictures the person sent with it (`sentPhotos.ts`); only a person's message has them. */
      images?: SentImage[];
    }
  /**
   * A message Studio sent the chat itself (`studioNotice.ts`): its words
   * without the name they open with, drawn as Studio's quiet row and never as
   * the person's bubble. `turn` is the turn it opened.
   */
  | { kind: "studio"; id: string; text: string; at: number; reason?: StudioMessageReason; turn?: string }
  /**
   * What the model thought on its way to the reply (`reasoning_delta`), one
   * row per stretch of thinking, where in the turn it happened. `live` while
   * it is the last thing the running turn has said: the model is thinking now.
   */
  | { kind: "reasoning"; id: string; text: string; at: number; live: boolean; turn?: string }
  | ToolsRow
  /**
   * A turn's work resting behind one line ("Worked for 2m 14s · 12 steps"):
   * its steps and what the agent said between them. Its agents, the pictures
   * it made and its reply stay outside.
   */
  | { kind: "fold"; id: string; turn: string; label: string; failed: number; live: boolean; parts: FoldPart[] }
  /** An agent the chat spawned: its own card, standing between the turn's steps. */
  | { kind: "agent"; id: string; lane: AgentLane }
  /** The provider summarised the conversation to free context. */
  | {
      kind: "compaction";
      id: string;
      trigger?: "manual" | "auto";
      /** Studio compacted the idle chat itself, just before its prompt cache expired. */
      beforeCacheExpiry?: true;
      preTokens?: number;
      postTokens?: number;
    }
  /**
   * The chat was handed off to a fresh session, pointed at a file of its
   * messages on the desktop, instead of being compacted.
   */
  | { kind: "handoff"; id: string; preTokens?: number }
  /** What a command the CLI ran by itself printed (`/context`, `/usage`); a `note` is the desktop's own remark. */
  | { kind: "command"; id: string; command?: string; output: string; note?: boolean }
  /**
   * A finished turn's footer: the model it ran on and how long it took.
   * `reply` when the turn said anything, which its footer offers to copy.
   */
  | { kind: "meta"; id: string; modelId?: string; durationMs?: number; at: number; turn?: string; reply?: true }
  /** A plan the agent proposed; it stays in the transcript after it is answered. */
  | PlanRow
  /**
   * What a finished turn changed. `turnSeq` opens the files and their diffs
   * when the desktop kept a checkpoint; without one the counts are all there is.
   */
  | { kind: "diff"; id: string; turnSeq?: number; changes?: TurnChanges };
/**
 * One turn the agent answered in, by the desktop's clock: when it began, and
 * when it ended once it has. A turn still running is `streaming`; one that
 * ended without saying so (its session stopped) has neither an end nor that.
 */
export type ReplyClock = { turn: string; startedAt: number; endedAt?: number; streaming: boolean };
/** A finished turn that changed files: its counts, and its checkpoint when the desktop kept one. */
export type ChangedTurn = { id: string; at: number; turnSeq?: number; changes?: TurnChanges };
export type PendingRequest = { id: string; at: number; payload: Record<string, unknown> };
export const stringValue = (value: unknown) => typeof value === "string" ? value : "";
export const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Sequence is authoritative; ids also deduplicate pre-sequence legacy history. */
export function mergeConversationEvents(current: ConversationEvent[], incoming: ConversationEvent[]) {
  if (incoming.length === 1) {
    const appended = appendNewest(current, incoming[0]);
    if (appended) return appended;
  }
  const ids = new Set(current.map((event) => event.id));
  const seqs = new Set(current.flatMap((event) => event.seq === undefined ? [] : [event.seq]));
  const added = incoming.filter((event) => {
    if (ids.has(event.id) || (event.seq !== undefined && seqs.has(event.seq))) return false;
    ids.add(event.id);
    if (event.seq !== undefined) seqs.add(event.seq);
    return true;
  });
  return added.length ? [...current, ...added].sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt)) : current;
}

/**
 * The events a running turn sends at the rate the model writes: a reply's
 * words, its thinking, a step's output. Each changes a row already drawn and
 * nothing else on the screen, so the screen may take several in one draw.
 * Anything else (a message arriving, a turn ending, a request for the
 * person) is drawn the moment it lands, with what the screen does about it.
 */
const STREAMED_EVENT_TYPES = new Set(["content_delta", "reasoning_delta", "tool_output"]);
export const isStreamedEvent = (event: Pick<ConversationEvent, "type">) => STREAMED_EVENT_TYPES.has(event.type);

/**
 * The live case, one event newer than everything held, merged in one pass
 * over the log with nothing built and nothing sorted: what the general merge
 * returns for it, which on a long chat's log cost several times the whole
 * projection. Null where the general merge must decide (a log out of order,
 * an event that sorts before its end).
 */
function appendNewest(current: ConversationEvent[], event: ConversationEvent): ConversationEvent[] | null {
  let last = -Infinity;
  for (const held of current) {
    if (held.id === event.id || (event.seq !== undefined && held.seq === event.seq)) return current;
    const key = held.seq ?? held.createdAt;
    if (!(key >= last)) return null;
    last = key;
  }
  return (event.seq ?? event.createdAt) >= last ? [...current, event] : null;
}

// The desktop stamps every event with the model the session was on; the
// phone's wire type leaves it out, but the field rides along untouched.
const eventModel = (event: ConversationEvent) => stringValue((event as { modelId?: unknown }).modelId);

// What the model sent an agent to do: the short description every Task call
// carries, else the one-line summary the provider wrote for the call.
function laneTask(payload: Record<string, unknown>, name: string): string {
  const described = stringValue(recordValue(payload.input).description).trim();
  if (described) return described;
  const summary = stringValue(payload.summary);
  return summary.startsWith(`${name}: `) ? summary.slice(name.length + 2) : summary;
}

export function projectConversation(events: ConversationEvent[]) {
  const rows: ConversationRow[] = [];
  const pending = new Map<string, PendingRequest>();
  const acknowledged = new Set<string>();
  // Turns Studio opened with its own `/compact` before the cache expired.
  const autoCompactTurns = new Set<string>();
  // A turn in flight, and when this spell of work began.
  let turnBusy = false;
  let turnSince: number | undefined;
  let currentTurn = "";
  let checkpointSeq: number | undefined;
  let toolGroup: ToolsRow | undefined;
  const tools = new Map<string, { tool: MobileTool; turn: string }>();
  // Every agent by the id of the call that spawned it, in spawn order. Reports
  // about an agent name that id alone, not the session: a background agent's
  // result arrives after its turn, on no turn at all.
  const lanes = new Map<string, AgentLane>();
  const laneTools = new Map<string, MobileTool>();
  // Reports and words that arrived before their lane (paging can split them),
  // applied when it does.
  const earlyReports = new Map<string, { report: AgentReport; at: number }>();
  const earlyMessages = new Map<string, AgentMessage[]>();
  // Steps whose lane has not arrived yet stay visible in the turn's own groups
  // and move under the lane once it does: an agent's work is never dropped
  // because its header is missing.
  const orphans = new Map<string, { tool: MobileTool; group: ToolsRow }[]>();
  const plans = new Map<string, PlanRow>();
  const agentTypes: Record<string, string> = {};
  const turnStarts = new Map<string, { at: number; modelId: string }>();
  const turnEnds = new Map<string, { status: "complete" | "failed" | "interrupted"; at: number; durationMs?: number }>();
  // The files each turn's steps reported changing (`fileChanges` on a
  // finished step), by step, for a turn the desktop kept no checkpoint
  // summary for. By step so that a step reported twice (a retransmission, a
  // replayed page) is counted once: its latest report replaces the last.
  const turnFiles = new Map<string, Map<string, StepFileChanges>>();
  // When each turn the agent answered in first showed, in the order they did:
  // the "New" divider reads a reply's clocks from it (`unreadDivider.ts`).
  const replyFirstAt = new Map<string, number>();
  // The turns whose words say anything: a footer offers a reply to copy only
  // where there is one.
  const spokenTurns = new Set<string>();
  // The provider's latest retry notice for the turn running now; anything
  // else the turn reports means the call went through.
  let retry: (TurnRetry & { turn: string }) | null = null;
  let promptCache: PromptCacheReading | null = null;
  let context: ContextReading | null = null;
  // Every turn that changed files, oldest first: the strip adds them up and
  // opens them (see conversationChanges).
  const changedTurns: ChangedTurn[] = [];
  const beginWork = (at: number) => {
    if (!turnBusy) turnSince = at;
    turnBusy = true;
  };
  for (const event of events) {
    const p = event.payload ?? {};
    const turn = stringValue(p.turnId) || currentTurn;
    promptCache = applyPromptCacheEvent(promptCache, event);
    context = applyContextEvent(context, event);
    if (retry && event.type !== "turn_retrying" && stringValue(p.turnId) === retry.turn) retry = null;
    if (event.type === "turn_retrying") {
      const attempt = numberValue(p.attempt);
      const maxAttempts = numberValue(p.maxAttempts);
      if (turn && attempt !== undefined && maxAttempts !== undefined)
        retry = {
          turn,
          attempt,
          maxAttempts,
          retryInMs: numberValue(p.retryInMs) ?? 0,
          ...(stringValue(p.error) ? { error: stringValue(p.error) } : {}),
          ...(numberValue(p.status) !== undefined ? { status: numberValue(p.status) } : {}),
          at: event.createdAt,
        };
      continue;
    }
    if (event.type === "user_message") {
      beginWork(event.createdAt);
      toolGroup = undefined;
      const commandId = stringValue(p.commandId);
      if (commandId) acknowledged.add(commandId);
      checkpointSeq = event.seq;
      const text = stringValue(p.text) || stringValue(p.message);
      const origin = readMessageOrigin(p.origin);
      // Studio's own `/compact` is said by the divider its compaction draws.
      if (origin?.reason === "auto-compact") {
        const turnId = stringValue(p.turnId);
        if (turnId) autoCompactTurns.add(turnId);
      } else if (origin)
        rows.push({
          kind: "studio", id: event.id, text: withoutStudioNoticePrefix(text), at: event.createdAt,
          ...(origin.reason ? { reason: origin.reason } : {}),
          ...(stringValue(p.turnId) ? { turn: stringValue(p.turnId) } : {}),
        });
      else {
        const files = parseAttachedFiles(p.files);
        const images = parseSentImages(p.attachments);
        rows.push({
          kind: "message", id: event.id, role: "user", text, at: event.createdAt, commandId,
          ...(files.length ? { files } : {}),
          ...(images.length ? { images } : {}),
        });
      }
    } else if (event.type === "turn_started") {
      beginWork(event.createdAt);
      toolGroup = undefined;
      currentTurn = turn || event.id;
      if (!turnStarts.has(currentTurn)) turnStarts.set(currentTurn, { at: event.createdAt, modelId: eventModel(event) });
      if (!replyFirstAt.has(currentTurn)) replyFirstAt.set(currentTurn, event.createdAt);
    } else if (event.type === "content_delta") {
      toolGroup = undefined;
      if (turn && !replyFirstAt.has(turn)) replyFirstAt.set(turn, event.createdAt);
      const text = stringValue(p.text) || stringValue(p.delta);
      if (turn && !spokenTurns.has(turn) && text.trim()) spokenTurns.add(turn);
      const last = rows.at(-1);
      // Prose between tool calls is its own row, not moved beneath later work.
      if (last?.kind === "message" && last.role === "assistant" && last.id.startsWith(`${turn}:`)) last.text += text;
      else rows.push({ kind: "message", id: `${turn}:${event.id}`, role: "assistant", text, at: event.createdAt, ...(turn ? { turn } : {}) });
    } else if (event.type === "reasoning_delta") {
      const text = stringValue(p.text) || stringValue(p.delta);
      const last = rows.at(-1);
      // One stretch of thinking is one row, however many deltas it came in;
      // a delta after the reply's words or a step begins another, in its place.
      if (last?.kind === "reasoning" && (last.turn ?? "") === turn) last.text += text;
      // Thinking that has said nothing yet is no row: a provider can open a
      // stretch with blank lines and never fill it.
      else if (text.trim()) {
        toolGroup = undefined;
        if (turn && !replyFirstAt.has(turn)) replyFirstAt.set(turn, event.createdAt);
        rows.push({ kind: "reasoning", id: `reasoning:${event.id}`, text: text.trimStart(), at: event.createdAt, live: false, ...(turn ? { turn } : {}) });
      }
    } else if (event.type === "tool_started") {
      const id = stringValue(p.toolUseId) || stringValue(p.toolCallId) || event.id;
      if (turn && !replyFirstAt.has(turn)) replyFirstAt.set(turn, event.createdAt);
      const key = `${event.sessionId}:${id}`;
      const name = stringValue(p.name) || stringValue(p.tool) || stringValue(p.toolName) || "Tool";
      const parentId = stringValue(p.parentToolUseId);
      const existing = tools.get(key)?.tool;
      const tool: MobileTool = {
        id, name,
        kind: presentToolItem({ name, kind: p.kind as PresentableTool["kind"] }).icon,
        input: p.input as PresentableTool["input"], summary: stringValue(p.summary), status: "running",
        startedAt: event.createdAt,
        ...(parentId && parentId !== id ? { parentToolUseId: parentId } : {}),
      };
      const subagentType = stringValue(p.subagentType) || stringValue(recordValue(p.input).subagent_type).trim();
      if (existing) {
        // Retransmitted lifecycle starts update one row without reopening a
        // tool whose final output already arrived.
        Object.assign(existing, { ...tool, status: existing.status,
          input: tool.input ?? existing.input,
          summary: tool.summary || existing.summary,
          kind: p.kind === undefined ? existing.kind : tool.kind,
          startedAt: existing.startedAt });
        const lane = lanes.get(id);
        if (lane) {
          lane.subagentType ||= subagentType || undefined;
          lane.task ||= laneTask(p, name);
        }
      } else {
        tools.set(key, { tool, turn });
        const parentLane = tool.parentToolUseId ? lanes.get(tool.parentToolUseId) : undefined;
        let lane: AgentLane | undefined;
        if (p.subagentLane === true || tool.kind === "subagent") {
          lane = {
            id, turn,
            ...(tool.parentToolUseId ? { parentId: tool.parentToolUseId } : {}),
            ...(subagentType ? { subagentType } : {}),
            task: laneTask(p, name),
            status: "running",
            startedAt: event.createdAt,
            messages: earlyMessages.get(id) ?? [],
            steps: [],
          };
          earlyMessages.delete(id);
          lanes.set(id, lane);
          laneTools.set(id, tool);
          const early = earlyReports.get(id);
          if (early) {
            earlyReports.delete(id);
            applyAgentReport(lane, early.report, early.at);
          }
          for (const orphan of orphans.get(id) ?? []) {
            orphan.group.tools.splice(orphan.group.tools.indexOf(orphan.tool), 1);
            lane.steps.push(orphan.tool);
          }
          orphans.delete(id);
        }
        if (parentLane) parentLane.steps.push(tool);
        else if (lane) {
          // An agent is a card of its own; the steps after it start a new group.
          toolGroup = undefined;
          rows.push({ kind: "agent", id: event.id, lane });
        } else {
          if (toolGroup) toolGroup.tools.push(tool);
          else {
            toolGroup = { kind: "tools", id: event.id, tools: [tool], ...(turn ? { turn } : {}) };
            rows.push(toolGroup);
          }
          if (tool.parentToolUseId)
            orphans.set(tool.parentToolUseId, [...(orphans.get(tool.parentToolUseId) ?? []), { tool, group: toolGroup }]);
        }
      }
    } else if (event.type === "tool_output") {
      const id = stringValue(p.toolUseId) || stringValue(p.toolCallId);
      const changedTurn = tools.get(`${event.sessionId}:${id}`)?.turn || turn;
      // A partial output is a step still running, not one that changed
      // anything yet; the desktop reads only a completed call's changes.
      if (Array.isArray(p.fileChanges) && changedTurn && p.partial !== true) {
        const steps = turnFiles.get(changedTurn) ?? new Map<string, StepFileChanges>();
        const files: StepFileChanges = new Map();
        for (const change of p.fileChanges.slice(0, 256).map(recordValue)) {
          const path = stringValue(change.path);
          if (!path || path.length > 4096) continue;
          const added = numberValue(change.additions) ?? numberValue(change.addedLines);
          const removed = numberValue(change.deletions) ?? numberValue(change.removedLines);
          files.set(path, { ...(added !== undefined ? { added } : {}), ...(removed !== undefined ? { removed } : {}) });
        }
        steps.set(id || event.id, files);
        turnFiles.set(changedTurn, steps);
      }
      const tool = tools.get(`${event.sessionId}:${id}`)?.tool;
      const lane = id ? lanes.get(id) : undefined;
      const output = typeof p.preview === "string" ? p.preview : stringValue(p.output);
      const status: MobileTool["status"] = p.partial === true ? "running" :
        p.status === "declined" || p.status === "stopped" || p.status === "error" ? p.status :
          p.isError === true ? "error" : "ok";
      if (lane && isBackgroundLaunchAck(output)) {
        // The notice a background agent's call returns at once is for the
        // model. The lane stays open for the agent's own report; history that
        // never recorded one can only say it ran in the background.
        lane.agent = { ...lane.agent, state: lane.agent?.state ?? "unknown", background: true };
        if (lane.agent.state === "unknown") {
          lane.status = "done";
          lane.completedAt ??= event.createdAt;
        }
      } else {
        if (tool) {
          tool.output = output;
          tool.status = status;
          tool.exitCode = typeof p.exitCode === "number" ? p.exitCode : undefined;
        }
        if (lane) {
          // The spawning call's output is the agent's report; a background
          // agent's arrives as its own result when it finishes.
          lane.report = output || lane.report;
          if (status !== "running") {
            lane.status = "done";
            lane.completedAt ??= event.createdAt;
            lane.outcome = status === "error" || status === "declined" || status === "stopped" ? status : "ok";
          }
        }
      }
    } else if (event.type === "subagent_status") {
      const status = readSubagentStatus(p);
      if (status) {
        const { toolUseId, endedAt, ...report } = status;
        const lane = lanes.get(toolUseId);
        if (lane) applyAgentReport(lane, report, endedAt ?? event.createdAt);
        else {
          const early = earlyReports.get(toolUseId);
          earlyReports.set(toolUseId, { report: { ...early?.report, ...report }, at: endedAt ?? event.createdAt });
        }
      }
    } else if (event.type === "subagent_message") {
      const parentId = stringValue(p.parentToolUseId);
      const text = stringValue(p.text);
      if (parentId && text) {
        const message: AgentMessage = { at: event.createdAt, text, ...(p.truncated === true ? { truncated: true } : {}) };
        const lane = lanes.get(parentId);
        if (lane) lane.messages.push(message);
        else earlyMessages.set(parentId, [...(earlyMessages.get(parentId) ?? []), message]);
      }
    } else if (event.type === "session_updated") {
      if (Array.isArray(p.agents))
        for (const agent of p.agents.map(recordValue)) {
          const name = stringValue(agent.name);
          const description = stringValue(agent.description);
          if (name && description) agentTypes[name] = description;
        }
    } else if (event.type === "context_compacted") {
      toolGroup = undefined;
      rows.push({
        kind: "compaction", id: event.id,
        ...(p.trigger === "manual" || p.trigger === "auto" ? { trigger: p.trigger } : {}),
        ...(turn && autoCompactTurns.has(turn) ? { beforeCacheExpiry: true as const } : {}),
        ...(numberValue(p.preTokens) !== undefined ? { preTokens: numberValue(p.preTokens) } : {}),
        ...(numberValue(p.postTokens) !== undefined ? { postTokens: numberValue(p.postTokens) } : {}),
      });
    } else if (event.type === "context_handed_off") {
      toolGroup = undefined;
      rows.push({
        kind: "handoff", id: event.id,
        ...(numberValue(p.preTokens) !== undefined ? { preTokens: numberValue(p.preTokens) } : {}),
      });
    } else if (event.type === "command_output") {
      const output = stringValue(p.output);
      if (output) {
        toolGroup = undefined;
        rows.push({
          kind: "command", id: event.id, output,
          ...(stringValue(p.command) ? { command: stringValue(p.command) } : {}),
          ...(p.adapterNote === true ? { note: true } : {}),
        });
      }
    } else if (event.type === "approval_requested") {
      const id = stringValue(p.requestId);
      if (id && p.autoApproved !== true) {
        pending.set(id, { id, at: event.createdAt, payload: p });
        if (p.kind === "plan") {
          toolGroup = undefined;
          const plan: PlanRow = { kind: "plan", id: event.id, requestId: id, plan: stringValue(p.plan), status: "pending" };
          plans.set(id, plan);
          rows.push(plan);
        }
      }
    } else if (event.type === "approval_resolved") {
      const id = stringValue(p.requestId);
      pending.delete(id);
      const plan = plans.get(id);
      if (plan) plan.status = p.approved === true ? "approved" : "denied";
    } else if (["turn_completed", "turn_failed", "session_closed", "session_stopped"].includes(event.type)) {
      turnBusy = false;
      // Whatever ended, nothing is waiting to retry now. A stop can name no
      // turn, so the notice is not left to the turn's own id to clear: kept,
      // it would stand over the next turn until that one ended.
      retry = null;
      pending.clear();
      for (const plan of plans.values()) if (plan.status === "pending") plan.status = "cancelled";
      toolGroup = undefined;
      const sessionEnded = event.type === "session_closed" || event.type === "session_stopped";
      if (event.type !== "turn_completed") {
        for (const value of tools.values()) if (value.tool.status === "running" &&
          (value.turn === turn || sessionEnded)) {
          value.tool.status = "stopped";
        }
        for (const lane of lanes.values()) {
          if (lane.status !== "running") continue;
          // A background agent outlives the turn that launched it, not its session.
          if (!sessionEnded && (lane.turn !== turn || (lane.agent?.background && lane.agent.state === "running"))) continue;
          lane.status = "done";
          lane.completedAt ??= event.createdAt;
          lane.outcome ??= "stopped";
        }
      }
      if (turn && (event.type === "turn_completed" || event.type === "turn_failed")) {
        const reason = stringValue(p.reason) || stringValue(p.message);
        turnEnds.set(turn, {
          status: event.type === "turn_completed" ? "complete" : reason === "interrupted" ? "interrupted" : "failed",
          at: event.createdAt,
          ...(numberValue(p.durationMs) !== undefined ? { durationMs: numberValue(p.durationMs) } : {}),
        });
      }
      if (event.type === "turn_failed") rows.push({ kind: "message", id: event.id, role: "assistant", text: stringValue(p.message) || "This turn could not finish.", at: event.createdAt });
      if (event.type === "turn_completed") {
        const started = turnStarts.get(turn);
        const modelId = eventModel(event) || started?.modelId || "";
        const durationMs = numberValue(p.durationMs) ?? (started ? Math.max(0, event.createdAt - started.at) : undefined);
        rows.push({
          kind: "meta", id: `meta:${event.id}`, at: event.createdAt,
          ...(modelId ? { modelId } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(turn ? { turn } : {}),
          ...(turn && spokenTurns.has(turn) ? { reply: true as const } : {}),
        });
      }
      if (event.type === "turn_completed" || event.type === "turn_failed") {
        const changes = turnChanges(p.checkpointSummary, filesOfTurn(turnFiles.get(turn)));
        const turnSeq =
          p.checkpointAvailable === true && checkpointSeq !== undefined
            ? typeof p.checkpointTurnSeq === "number" ? p.checkpointTurnSeq : checkpointSeq
            : undefined;
        // A checkpoint whose summary counts no files changed nothing worth a
        // row, as on the desktop; one without a summary still opens.
        if ((turnSeq !== undefined && changes?.files !== 0) || (changes && changes.files > 0)) {
          rows.push({
            kind: "diff",
            id: `diff:${event.id}`,
            ...(turnSeq !== undefined ? { turnSeq } : {}),
            ...(changes ? { changes } : {}),
          });
          changedTurns.push({
            id: `diff:${event.id}`,
            at: event.createdAt,
            ...(turnSeq !== undefined ? { turnSeq } : {}),
            ...(changes ? { changes } : {}),
          });
        }
      }
    }
  }
  // A lane's own call reads as the lane does wherever it is drawn as a step
  // (an agent an agent spawned).
  for (const lane of lanes.values()) {
    const tool = laneTools.get(lane.id);
    if (tool) tool.status = lane.status === "running" ? "running" : lane.outcome ?? "ok";
  }
  const agents = [...lanes.values()];
  // A background agent keeps the chat working after the turn that launched it.
  const background = agents.filter((lane) => lane.status === "running" && lane.agent?.background === true);
  const workingSince = turnBusy
    ? turnSince
    : background.length
      ? Math.min(...background.map((lane) => lane.startedAt))
      : undefined;
  // Thinking is going on now only while it is the last thing the running
  // turn has said: words or a step after it mean the model moved on.
  const lastRow = rows.at(-1);
  if (lastRow?.kind === "reasoning" && turnBusy && (lastRow.turn ?? "") === currentTurn) lastRow.live = true;
  const kept = rows.filter((row) => row.kind !== "tools" || row.tools.length > 0);
  return {
    rows: foldTurns(kept, (turn) => {
      const ended = turnEnds.get(turn);
      const started = turnStarts.get(turn)?.at;
      return {
        status: ended?.status ?? (turnBusy && turn === currentTurn ? "streaming" : "complete"),
        durationMs: ended && started !== undefined ? Math.max(0, ended.at - started) : ended?.durationMs,
      };
    }),
    /** The provider is waiting to retry a failed call in the turn running now. */
    retrying: turnBusy && retry ? (({ turn: _turn, ...rest }) => rest)(retry) : null,
    pending: [...pending.values()],
    acknowledged,
    /** A turn is in flight or a background agent still runs. */
    busy: turnBusy || background.length > 0,
    /** A turn is in flight: a send now waits for it to end. */
    turnBusy,
    workingSince,
    lanes: agents,
    plans: Object.fromEntries([...plans].map(([id, plan]) => [id, { plan: plan.plan, status: plan.status }])) as Record<string, { plan: string; status: PlanStatus }>,
    agentTypes,
    promptCache,
    /** How much of the model's context window the chat holds; null until a report says. */
    context,
    changedTurns,
    /** Every turn the agent answered in, oldest first, with when it began and ended. */
    replies: [...replyFirstAt].map(([turn, firstAt]): ReplyClock => {
      const ended = turnEnds.get(turn)?.at;
      return {
        turn,
        startedAt: turnStarts.get(turn)?.at ?? firstAt,
        ...(ended !== undefined ? { endedAt: ended } : {}),
        streaming: ended === undefined && turnBusy && turn === currentTurn,
      };
    }),
  };
}

/**
 * A new projection's rows, keeping each row that reads as it did as the
 * object it was. Every projection builds every row afresh, so without this a
 * streamed delta handed the list 600 new rows to draw for the one that
 * changed; a row kept as it was is skipped by its memo.
 */
export function keepUnchangedRows(previous: readonly ConversationRow[], next: ConversationRow[]): ConversationRow[] {
  return keepUnchanged(previous, next, (row) => row.id);
}

// ── Retries ────────────────────────────────────────────────────────────────

/**
 * The working line while the provider waits to retry a failed call: what went
 * wrong, and how far through its attempts it is ("Couldn't authenticate ·
 * retrying (3 of 10)…"). The reason leads because it is the one thing a
 * person can act on: an expired sign-in, a limit.
 */
export function retryLabel(retry: Pick<TurnRetry, "attempt" | "maxAttempts" | "error" | "status">): string {
  return `${retryReason(retry)} · retrying (${retry.attempt} of ${retry.maxAttempts})…`;
}
function retryReason({ error, status }: Pick<TurnRetry, "error" | "status">): string {
  switch (error) {
    case "authentication_failed":
      return "Couldn\u2019t authenticate";
    case "rate_limit":
      return "Rate limited";
    case "overloaded":
      return "Service overloaded";
    case "server_error":
      return "Server error";
    case "billing_error":
      return "Billing problem";
  }
  if (status === 401 || status === 403) return "Couldn\u2019t authenticate";
  if (status === 429) return "Rate limited";
  if (status === 529) return "Service overloaded";
  // No response at all: the request never reached the service.
  if (status === undefined) return "Couldn\u2019t connect";
  return `Request failed (${status})`;
}

// ── Turn folds ─────────────────────────────────────────────────────────────

/**
 * A turn's changed files from its steps' reports: each path once, its lines
 * summed over the steps that changed it, and left uncounted when any of those
 * steps did not say.
 */
function filesOfTurn(steps: ReadonlyMap<string, StepFileChanges> | undefined) {
  if (!steps?.size) return undefined;
  const files = new Map<string, { added?: number; removed?: number; unknown?: { added?: true; removed?: true } }>();
  for (const step of steps.values())
    for (const [path, change] of step) {
      const seen = files.get(path) ?? {};
      const unknown = { ...seen.unknown };
      if (change.added === undefined) unknown.added = true;
      if (change.removed === undefined) unknown.removed = true;
      files.set(path, {
        added: (seen.added ?? 0) + (change.added ?? 0),
        removed: (seen.removed ?? 0) + (change.removed ?? 0),
        unknown,
      });
    }
  return new Map(
    [...files].map(([path, { added, removed, unknown }]) => [
      path,
      { ...(unknown?.added ? {} : { added }), ...(unknown?.removed ? {} : { removed }) },
    ]),
  );
}

/**
 * What a turn changed: the desktop's checkpoint summary when it kept one
 * (`checkpointSummary` on the turn's end), else the distinct files the turn's
 * steps reported (`fileChanges` on a finished step), with line counts only
 * where every file named them. Null when neither says anything.
 */
export function turnChanges(
  summary: unknown,
  files: ReadonlyMap<string, { added?: number; removed?: number }> | undefined,
): TurnChanges | null {
  const listed = recordValue(summary);
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const counted = count(listed.files);
  if (counted !== undefined && count(listed.addedLines) !== undefined && count(listed.removedLines) !== undefined)
    return { files: counted, addedLines: count(listed.addedLines), removedLines: count(listed.removedLines) };
  if (!files?.size) return null;
  const entries = [...files.values()];
  const sum = (key: "added" | "removed") =>
    entries.every((entry) => entry[key] !== undefined) ? entries.reduce((total, entry) => total + (entry[key] ?? 0), 0) : undefined;
  const addedLines = sum("added");
  const removedLines = sum("removed");
  return {
    files: files.size,
    ...(addedLines !== undefined ? { addedLines } : {}),
    ...(removedLines !== undefined ? { removedLines } : {}),
  };
}

/** "3 files changed · +42 −7". */
export function turnChangesLabel(changes: TurnChanges): string {
  const files = `${changes.files} ${changes.files === 1 ? "file" : "files"} changed`;
  const lines =
    changes.addedLines !== undefined && changes.removedLines !== undefined
      ? `+${changes.addedLines} \u2212${changes.removedLines}`
      : "";
  return [files, lines].filter(Boolean).join(" · ");
}

// A markdown or HTML image: the reply draws it, so prose carrying one is
// something to see, not a step on the way.
const PICTURE = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\b/iu;
/** A step whose result is for the person to look at: a picture the agent generated. */
export function stepShownToUser(tool: MobileTool): boolean {
  return tool.name === "GenerateImage" && tool.status !== "error";
}

type TurnState = { status: "streaming" | "complete" | "failed" | "interrupted"; durationMs?: number };

/** The fold's line, in the desktop's words: "Worked for 2m 14s · 12 steps". */
export function turnFoldLabel(state: TurnState, steps: number): string {
  const duration = state.durationMs === undefined ? "" : formatDuration(state.durationMs);
  const lead =
    state.status === "streaming"
      ? "Working"
      : state.status === "failed"
        ? duration ? `Failed after ${duration}` : "Failed"
        : state.status === "interrupted"
          ? duration ? `You stopped after ${duration}` : "You stopped"
          : duration ? `Worked for ${duration}` : "Worked";
  return steps ? `${lead} · ${steps} ${steps === 1 ? "step" : "steps"}` : lead;
}

/**
 * Every turn's work rests behind one line, the turn running now included: its
 * steps, and what the agent said between them. The agents it sent off stay
 * cards of their own, the reply stays as written, and prose that shows a
 * picture stays in view; a generated picture is drawn under the line. A turn
 * with no steps, or whose only steps made pictures, is left as it is: its
 * reply and its pictures are all there is, as on the desktop.
 *
 * The fold stands where the turn's first folded row stood, so the agents and
 * the reply follow it as they do on the desktop.
 */
export function foldTurns(rows: ConversationRow[], stateOf: (turn: string) => TurnState): ConversationRow[] {
  const turnOf = (row: ConversationRow) =>
    row.kind === "tools" || row.kind === "reasoning"
      ? row.turn
      : row.kind === "message" && row.role === "assistant"
        ? row.turn
        : undefined;
  const lastStep = new Map<string, number>();
  // Only a step that is work counts: a turn whose steps all made a picture
  // for the person has nothing to fold, and its picture stays as it is.
  rows.forEach((row, index) => {
    if (row.kind === "tools" && row.turn && row.tools.some((tool) => !stepShownToUser(tool))) lastStep.set(row.turn, index);
  });
  const folds = new Map<string, Extract<ConversationRow, { kind: "fold" }>>();
  const out: ConversationRow[] = [];
  rows.forEach((row, index) => {
    const turn = turnOf(row);
    const last = turn === undefined ? undefined : lastStep.get(turn);
    // Thinking before the turn's last step folds with the work it led to, as
    // its prose does; the thinking after it stays in view above the reply.
    const folded =
      turn !== undefined &&
      last !== undefined &&
      (row.kind === "tools" ||
        (row.kind === "reasoning" && index < last) ||
        (row.kind === "message" && index < last && !PICTURE.test(row.text)));
    if (!folded || turn === undefined || (row.kind !== "tools" && row.kind !== "message" && row.kind !== "reasoning")) {
      out.push(row);
      return;
    }
    let fold = folds.get(turn);
    if (!fold) {
      fold = { kind: "fold", id: `fold:${turn}`, turn, label: "", failed: 0, live: false, parts: [] };
      folds.set(turn, fold);
      out.push(fold);
    }
    fold.parts.push(
      row.kind === "tools"
        ? { kind: "tools", id: row.id, tools: row.tools }
        : row.kind === "reasoning"
          ? { kind: "reasoning", id: row.id, text: row.text }
          : { kind: "prose", id: row.id, text: row.text },
    );
  });
  for (const fold of folds.values()) {
    const steps = fold.parts.flatMap((part) => (part.kind === "tools" ? part.tools : []));
    const counted = steps.filter((tool) => !stepShownToUser(tool));
    const state = stateOf(fold.turn);
    fold.live = state.status === "streaming";
    fold.label = turnFoldLabel(state, counted.length);
    fold.failed = counted.filter((tool) => tool.status !== "running" && toolStep(tool).failed).length;
  }
  return out;
}

// ── Quiet tool steps ───────────────────────────────────────────────────────

function basename(path: string) {
  return path.split(/[\\/]/).at(-1) || path;
}
/**
 * One step as a quiet row draws it: the kind's glyph, a verb ("Read",
 * "Searching"), the thing it acted on in mono, and at the end how it went
 * wrong, when it did. A non-zero exit counts as going wrong.
 */
export function toolStep(tool: MobileTool): {
  kind: ConversationToolKind;
  label: string;
  detail: string;
  end: string;
  failed: boolean;
  live: boolean;
} {
  const presented = presentToolItem(tool);
  const input = recordValue(tool.input);
  const read = (...keys: string[]) => keys.map((key) => stringValue(input[key])).find(Boolean) ?? "";
  const legacy = tool.summary?.startsWith(`${tool.name}: `) ? tool.summary.slice(tool.name.length + 2) : tool.summary ?? "";
  let label = presented.verb;
  let detail: string;
  switch (presented.icon) {
    case "file_read":
    case "file_edit":
    case "file_write":
      detail = basename(read("path", "file_path", "filePath") || legacy);
      break;
    case "search":
      detail = read("pattern", "query") || legacy;
      break;
    case "list":
      detail = read("path", "directory", "pattern") || legacy;
      break;
    case "command":
      detail = (read("command", "cmd") || legacy).trim().split("\n")[0];
      break;
    case "web": {
      const url = read("url");
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* A malformed URL still has a readable label. */
      }
      detail = read("query") || host || legacy;
      break;
    }
    case "subagent": {
      const type = stringValue(tool.subagentType) || read("subagent_type");
      detail = type ? `${type} agent` : read("description") || "agent";
      break;
    }
    case "todo":
      detail = "plan";
      break;
    case "mcp":
      detail = presented.title;
      break;
    default:
      // A step the presentation names in its own words ("Generated image",
      // "Waited 10s") says them, as the desktop does; any other names its tool.
      if (presented.title && presented.title !== tool.name) {
        label = presented.title;
        detail = "";
      } else detail = tool.name;
  }
  const live = tool.status === "running";
  const exit = !live && tool.exitCode ? tool.exitCode : 0;
  const failed = !live && (exit !== 0 || presented.tone === "error");
  const end = exit
    ? `exit ${exit}`
    : live
      ? ""
      : tool.status === "error"
        ? "Failed"
        : tool.status === "declined"
          ? "Declined"
          : tool.status === "stopped"
            ? "Stopped"
            : "";
  return { kind: presented.icon, label, detail, end, failed, live };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// Each kind as one clause of a group's summary. The first clause leads with
// its verb ("Read 4 files"); the rest follow quietly ("· 1 search").
const CLAUSES: Record<ConversationToolKind, (count: number) => string> = {
  file_read: (count) => `read ${plural(count, "file", "files")}`,
  file_edit: (count) => `edited ${plural(count, "file", "files")}`,
  file_write: (count) => `wrote ${plural(count, "file", "files")}`,
  search: (count) => plural(count, "search", "searches"),
  list: (count) => `listed ${plural(count, "folder", "folders")}`,
  command: (count) => `ran ${plural(count, "command", "commands")}`,
  web: (count) => `fetched ${plural(count, "page", "pages")}`,
  mcp: (count) => plural(count, "tool call", "tool calls"),
  subagent: (count) => plural(count, "agent", "agents"),
  todo: () => "updated the plan",
  other: (count) => plural(count, "tool call", "tool calls"),
};
/**
 * What a settled group says while it rests collapsed: the kind it is mostly
 * made of (its glyph), "Read 4 files" then "1 search", and how many of its
 * steps went wrong. A failure is the one thing that must not fold away.
 */
export function describeToolGroup(tools: MobileTool[]): {
  kind: ConversationToolKind;
  head: string;
  rest: string[];
  failed: number;
} {
  const counts = new Map<ConversationToolKind, number>();
  for (const tool of tools) {
    const kind = presentToolItem(tool).icon;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const [head = "", ...rest] = ranked.map(([kind, count]) => CLAUSES[kind](count));
  return {
    kind: ranked[0]?.[0] ?? "other",
    head: head ? head[0].toUpperCase() + head.slice(1) : "No steps",
    rest,
    failed: tools.filter((tool) => toolStep(tool).failed).length,
  };
}

// ── Turn meta, compaction, plans ───────────────────────────────────────────

/** "Context compacted · automatically · 182k → 24k". */
export function compactionLabel(row: Extract<ConversationRow, { kind: "compaction" }>): string {
  const tokens =
    row.preTokens === undefined
      ? undefined
      : row.postTokens === undefined
        ? `from ${formatTokenCount(row.preTokens)} tokens`
        : `${formatTokenCount(row.preTokens)} → ${formatTokenCount(row.postTokens)}`;
  const trigger = row.beforeCacheExpiry
    ? "automatically, before the cache expired"
    : row.trigger === "auto"
      ? "automatically"
      : row.trigger === "manual"
        ? "on request"
        : undefined;
  return ["Context compacted", trigger, tokens].filter(Boolean).join(" · ");
}

/** "Handed off to a new session · 221k tokens left behind", as the desktop's divider says it. */
export function handoffLabel(row: Extract<ConversationRow, { kind: "handoff" }>): string {
  const left = row.preTokens !== undefined ? `${formatTokenCount(row.preTokens)} tokens left behind` : undefined;
  return ["Handed off to a new session", left].filter(Boolean).join(" · ");
}

/** A model id as a person reads it: the chat's catalog name, else the id without its date suffix. */
export function turnModelLabel(modelId: string | undefined, thread?: ConversationThread): string {
  if (!modelId || modelId === DEFAULT_MODEL_ID) return "";
  return thread?.models?.options.find((option) => option.id === modelId)?.label || modelId.replace(/-\d{8}$/u, "");
}
/** A finished turn's footer before its clock: "Opus 5.5 · 2m 14s". */
export function turnMetaParts(row: Extract<ConversationRow, { kind: "meta" }>, thread?: ConversationThread): string[] {
  return [turnModelLabel(row.modelId, thread), row.durationMs !== undefined ? formatDuration(row.durationMs) : ""].filter(Boolean);
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
/** The plan's own name: its first heading, when it has one. */
export function planTitle(plan: string): string | null {
  for (const line of plan.split(/\r?\n/u)) {
    const match = HEADING.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
/** The plan under its title: a leading heading is already the card's title. */
export function planBody(plan: string): string {
  const lines = plan.trim().split(/\r?\n/u);
  if (lines[0] && HEADING.test(lines[0])) lines.shift();
  return lines.join("\n").trim();
}

// ── Header and composer ────────────────────────────────────────────────────

/** "Claude Code · Opus 5.5": the chat's CLI and model, where the desktop says. */
export function cliModelLabel(thread: ConversationThread): string {
  const catalog = thread.models;
  const model = turnModelLabel(thread.modelId, thread) || (catalog ? "default model" : "");
  return [catalog?.cliLabel || catalog?.cli, model].filter(Boolean).join(" · ");
}
/** The permission chip's word for a preset: the desktop's own chip-width name. */
export function permissionLabel(preset: ConversationThread["permissionPreset"]): string {
  return PERMISSION_PRESET_OPTIONS.find((option) => option.id === preset)?.chip ?? "No flag";
}
/**
 * The presets the permission sheet offers for a chat: all four where the
 * desktop runs them (cut to the ones the chat's provider lists, else to the
 * ones its CLI's chat runs), Bypass and No flag where it does not, and always
 * the one the chat is on now.
 */
export function permissionChoices(session: MobileSession, thread: ConversationThread) {
  return offeredPermissionPresets({
    fourPresets: declaresPermissionModes(session),
    listed: thread.capabilities?.permissionPresets,
    cli: thread.models?.cli?.trim() || cliForChatProvider(thread.providerId),
    current: thread.permissionPreset,
  });
}

/** The CLI's own default model: what `setModel` names to drop a chosen model. */
export const DEFAULT_MODEL_ID = "default";
export type ModelChoice = { id: string; label: string; current: boolean };
/**
 * What the model control shows for a chat: the current model's friendly name,
 * the rows a person can pick (the CLI's default first, then its catalog), and
 * whether picking is offered at all. Null hides the control: the desktop did
 * not declare `conversation-models`, it listed no catalog for this chat, or
 * this phone may not operate the chat. A chat whose provider cannot switch
 * models mid-conversation shows its model read-only: the desktop refuses a
 * switch for it, started or not, since a listed chat always has a session or
 * a transcript to resume.
 */
export function modelControl(
  session: MobileSession,
  thread: ConversationThread,
): { label: string; choices: ModelChoice[]; editable: boolean } | null {
  const catalog = thread.models;
  if (!catalog || !conversationCanOperate(session)) return null;
  if (!declaresConversationModels(session)) return null;
  const current = thread.modelId || DEFAULT_MODEL_ID;
  const choices: ModelChoice[] = [
    { id: DEFAULT_MODEL_ID, label: `${catalog.cliLabel || catalog.cli} default`, current: current === DEFAULT_MODEL_ID },
    ...catalog.options.map((option) => ({
      id: option.id,
      label: option.label || option.id,
      current: option.id === current,
    })),
  ];
  return {
    label: modelLabel(thread),
    choices,
    editable: catalog.liveModelSwitch,
  };
}
/** A model's friendly name: its catalog label, the CLI's name for its default, else the raw id. */
export function modelLabel(thread: ConversationThread): string {
  const catalog = thread.models;
  const id = thread.modelId || DEFAULT_MODEL_ID;
  if (id === DEFAULT_MODEL_ID) return catalog ? `${catalog.cliLabel || catalog.cli} default` : "Default model";
  return catalog?.options.find((option) => option.id === id)?.label || id;
}

/** The longest preview a closed thought shows: one line of it is all that fits. */
const PREVIEW_MAX = 160;
/** How much of a thought the preview reads: its opening, never the whole trace. */
const PREVIEW_READ = 2_048;
/**
 * The line a closed thought previews, as plain words: its first line that is
 * not a fence or a rule, without the marks that make it a heading, a quote or
 * a list item, or bold, code or a link. Only the thought's opening is read,
 * so a trace streaming in one long paragraph costs the same each delta
 * however long it grows.
 */
export function reasoningPreview(text: string): string {
  const head = text.length > PREVIEW_READ ? text.slice(0, PREVIEW_READ) : text;
  let line = "";
  for (let start = 0; start < head.length; ) {
    const end = head.indexOf("\n", start);
    const part = head.slice(start, end === -1 ? head.length : end).trim();
    if (part && !/^(```|~~~|---|\*\*\*)/u.test(part)) {
      line = part;
      break;
    }
    if (end === -1) break;
    start = end + 1;
  }
  const words = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/(\*\*|__|`)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .trim();
  return words.length > PREVIEW_MAX ? `${words.slice(0, PREVIEW_MAX - 1).trimEnd()}\u2026` : words;
}

/**
 * Whether a row is drawn as an agent's reply: Markdown with its diagrams and
 * typeset math. A person's own message never is; it is the text they wrote.
 */
export function drawnAsReply(row: ConversationRow): boolean {
  return row.kind === "message" && row.role === "assistant";
}

/**
 * The turn still arriving, if one is (`replies`' streaming turn); a reply
 * in it, or a fold of its work, is still streaming.
 */
export function streamingTurn(replies: readonly ReplyClock[]): string | null {
  return replies.find((reply) => reply.streaming)?.turn ?? null;
}

/**
 * Whether a reply row may still change: a message of the streaming turn, or
 * one with no turn while a turn is busy (an older desktop's deltas name
 * none), and a fold while its turn is live. Its diagrams and formulas draw
 * only once their blocks are complete while it is (`replyBlockReady`).
 */
export function rowStreaming(row: ConversationRow, turn: string | null, turnBusy: boolean): boolean {
  if (row.kind === "fold" || row.kind === "reasoning") return row.live;
  if (!drawnAsReply(row) || row.kind !== "message") return false;
  return row.turn ? row.turn === turn : turnBusy;
}
