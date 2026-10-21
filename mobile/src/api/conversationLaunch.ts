import { isConversationWirePermissionPreset } from "./conversation-protocol/index";
import { plainLineBreaks, type ConversationPermissionPreset, type ConversationThread } from "./conversationWire";
import { readPeerRefusal } from "./tailnetTransport";

// Starting a chat on a paired desktop: the gateway's `conversation.create` tool,
// over the same stateless JSON-RPC POST `workspace.list` rides. The tool starts
// a new chat in the chosen project's folder, starts its session and sends the
// prompt as its first message, and answers once the session is up, without waiting for the
// reply. The phone then subscribes to the conversation like any other.
//
// Everything that decides what is sent and what an answer means is pure and
// exported, so the regression suite reads the same rules the screen runs.

const TAILNET_MCP_PATH = "/tailnet/v1/mcp";
// A launch waits on a real CLI starting on the desktop; the desktop's own mesh
// caller allows a minute for the same call.
export const CONVERSATION_CREATE_TIMEOUT_MS = 60_000;

export interface CreateConversationInput {
  workspaceId: string;
  /** The chat's first message. */
  prompt?: string;
  /** CLI plugin id from `cli.runtime.list`; omitted takes the desktop's last-selected CLI. */
  cli?: string;
  /** That CLI's model id; the CLI's own default when omitted. */
  cliModel?: string;
  /**
   * Omitted, the preset the desktop chose for that CLI. `manual` and `auto`
   * only to a desktop that declares `conversation-permission-modes`: an older
   * one reads either as `none`.
   */
  permissionPreset?: ConversationPermissionPreset;
  /**
   * Start the chat as a chat of its own in the workspace's folder, rather than
   * as one more agent inside that workspace. A workspace on the desktop is one
   * chat and its name is that chat's title, so a phone's New added to an
   * existing workspace wore the older chat's title and sat inside it. A
   * desktop from before the argument ignores it and does the latter.
   */
  newChat?: boolean;
  /**
   * With `newChat`, start the chat in a worktree of its own, cut as the
   * desktop's New chat cuts one: from its worktree pool, on the project's
   * branch, filed under the project. Only to a desktop that advertises
   * `new-chat-worktree`: an older one skips the argument and starts the chat
   * in the checkout. Refused as `worktree_unavailable` (a folder that is not
   * a repository, or one on an SSH machine), with nothing started.
   */
  worktree?: boolean;
  /**
   * The effort the chat runs at, one of the CLI's `reasoningLevels`. Only to a
   * desktop that advertises `new-chat-effort`; another level is refused as
   * `unsupported_effort`. Omitted, the CLI's own default.
   */
  effort?: string;
}

/** What the tool answers once the session is up. */
export interface LaunchedConversation {
  workspaceId: string;
  agentId: string;
  name: string;
  cli: string;
  providerId: string;
  modelId: string;
  sessionId: string;
}

/**
 * `unsupported` means the desktop is on a build from before the tool: nothing
 * the phone can send will start a chat there, and updating Studio is the one
 * way on.
 */
export type ConversationLaunchFailure = "unsupported" | "refused" | "unavailable" | "unpaired";

export type CreateConversationResult =
  | { ok: true; conversation: LaunchedConversation }
  | {
      ok: false;
      failure: ConversationLaunchFailure;
      title: string;
      message?: string;
      /** The desktop's refusal code, where it gave one New can act on (`worktree_unavailable`). */
      code?: string;
    };

/**
 * The tool's arguments, as the desktop's own mesh caller builds them: only
 * what was actually chosen. An empty string would be a choice of nothing, and
 * the tool reads a present field as a choice.
 */
export function buildConversationCreateArgs(input: CreateConversationInput): Record<string, unknown> {
  const args: Record<string, unknown> = { workspaceId: input.workspaceId.trim() };
  const prompt = input.prompt === undefined ? "" : plainLineBreaks(input.prompt).trim();
  if (prompt) args.prompt = prompt;
  if (input.cli?.trim()) args.cli = input.cli.trim();
  if (input.cliModel?.trim()) args.cliModel = input.cliModel.trim();
  if (isConversationWirePermissionPreset(input.permissionPreset)) {
    args.permissionPreset = input.permissionPreset;
  }
  if (input.newChat) args.newChat = true;
  // A worktree is where a new chat is born; the desktop refuses one asked
  // for a chat joining a workspace, so it is never sent without `newChat`.
  if (input.newChat && input.worktree) args.worktree = true;
  const effort = input.effort?.trim();
  if (effort) args.effort = effort;
  return args;
}

/**
 * What the gateway's answer means, in the words the screen shows.
 *
 * The desktop's refusals are written for its own log and for an agent calling
 * the tool ("Workspace "ws-3" is not known to the running app."), so the codes
 * a person can act on are said again here in their terms. A code this phone
 * does not know keeps the desktop's own sentence: it is still the most precise
 * thing available.
 */
export function readConversationCreateAnswer(
  status: number,
  body: unknown,
  machineName: string,
): CreateConversationResult {
  const machine = machineName.trim() || "The desktop";
  if (status === 401) {
    // Refused over the tailnet node, not the token: whois could not place this
    // phone for a moment (try again), or knows the pairing from another node.
    const refusal = readPeerRefusal(status, body);
    if (refusal?.code === "peer_unverified")
      return { ok: false, failure: "unavailable", title: `${machine} could not confirm this phone through Tailscale.`, message: "Try again in a moment." };
    if (refusal) return { ok: false, failure: "unpaired", title: refusal.message };
    return { ok: false, failure: "unpaired", title: `This phone is no longer paired with ${machine}.`, message: "Pair again from Settings." };
  }
  if (!isRecord(body) || status < 200 || status >= 300) {
    return { ok: false, failure: "unavailable", title: `${machine} could not start the chat.`, message: `It answered ${status}.` };
  }
  if (isRecord(body.error)) {
    const message = typeof body.error.message === "string" ? body.error.message : "";
    // A build from before `conversation.create` has no such tool. The mesh
    // caller on the desktop reads the same sentence for the same reason.
    if (/Unknown tool/u.test(message) || body.error.code === JSONRPC_METHOD_NOT_FOUND) return chatLaunchUnsupported(machine);
    return { ok: false, failure: "refused", title: `${machine} could not start the chat.`, message: message || undefined };
  }
  const result = isRecord(body.result) ? body.result : null;
  const structured = result && isRecord(result.structuredContent) ? result.structuredContent : null;
  if (result?.isError === true || structured?.ok === false) {
    const error = structured && isRecord(structured.error) ? structured.error : null;
    const code = typeof error?.code === "string" ? error.code : "";
    const detail = typeof error?.message === "string" ? error.message : "";
    return refusal(code, detail, machine);
  }
  // Anything without the tool's own shape is a desktop that answered some other
  // call than the one asked, which in practice is an older build.
  const conversation = structured && isRecord(structured.conversation) ? structured.conversation : null;
  if (!conversation) return chatLaunchUnsupported(machine);
  const workspaceId = text(conversation.workspaceId);
  const agentId = text(conversation.agentId);
  if (!workspaceId || !agentId) {
    return {
      ok: false,
      failure: "refused",
      title: `${machine} started the chat but did not say which one it is.`,
      message: "Find it under Chats.",
    };
  }
  return {
    ok: true,
    conversation: {
      workspaceId,
      agentId,
      name: text(conversation.name),
      cli: text(conversation.cli),
      providerId: text(conversation.providerId),
      modelId: text(conversation.modelId),
      sessionId: text(conversation.sessionId),
    },
  };
}

/** What an older desktop earns, worded as the desktop's own mesh caller words it. */
export function chatLaunchUnsupported(machine: string): CreateConversationResult {
  return {
    ok: false,
    failure: "unsupported",
    title: `${machine} cannot start chat agents yet.`,
    message: "Update SprintEngine Studio there to start one from the phone.",
  };
}

function refusal(code: string, detail: string, machine: string): CreateConversationResult {
  const refused = (title: string, message?: string, carried?: string): CreateConversationResult => ({
    ok: false,
    failure: "refused",
    title,
    message,
    ...(carried ? { code: carried } : {}),
  });
  switch (code) {
    case "tailnet_scope_required":
      return refused(`This phone may not start chats on ${machine}.`, "Pair again with chat control to start one here.");
    case "unknown_workspace":
      return refused(`That project is no longer open on ${machine}.`, "Open it in Studio there, then try again.");
    case "workspace_folder_missing":
      return refused(`That project has no folder on ${machine}, so there is nowhere to start the chat.`);
    case "no_cli_selected":
      return refused(`${machine} has no CLI chosen yet.`, "Pick one under Agent and model.");
    case "cli_not_conversational":
      return refused(`That CLI cannot run as a chat on ${machine}.`, "Pick another under Agent and model.");
    // The desktop's reason says which ("…is not a git repository…", an SSH
    // machine's folder, git's own failure), and nothing was started: New
    // keeps the prompt and offers to start without one.
    case "worktree_unavailable":
      return refused(`${machine} could not make a worktree for the chat.`, detail || undefined, code);
    case "unsupported_effort":
      return refused(`${machine} does not offer that effort for this CLI.`, detail || "Pick another under Agent and model.", code);
    default:
      return refused(`${machine} could not start the chat.`, detail || undefined);
  }
}

/**
 * The thread to open when the list has not caught up with the launch yet.
 *
 * Only what the tool said is filled in; the rest is what a chat that has just
 * started is. The conversation screen replaces all of it from its first
 * snapshot, so a guess here lasts one frame.
 */
export function threadFromLaunch(
  conversation: LaunchedConversation,
  options: { now: number; permissionPreset?: ConversationPermissionPreset },
): ConversationThread {
  return {
    workspaceId: conversation.workspaceId,
    agentId: conversation.agentId,
    ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
    title: conversation.name || "Chat",
    phase: "starting",
    updatedAt: options.now,
    createdAt: options.now,
    providerId: conversation.providerId,
    modelId: conversation.modelId,
    turnCount: 0,
    lastSeq: 0,
    ...(options.permissionPreset ? { permissionPreset: options.permissionPreset } : {}),
  };
}

/** The listed thread for a launch, which carries the catalog and capabilities the tool does not. */
export function findLaunchedThread(
  threads: readonly ConversationThread[],
  conversation: Pick<LaunchedConversation, "workspaceId" | "agentId">,
): ConversationThread | null {
  return (
    threads.find((thread) => thread.workspaceId === conversation.workspaceId && thread.agentId === conversation.agentId) ??
    null
  );
}

/**
 * Starts a chat on one paired desktop. Never throws: a desktop that did not
 * answer is a result the screen shows, like any refusal.
 */
export async function createConversation(
  target: { baseUrl: string; deviceToken: string; machineName: string },
  input: CreateConversationInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; requestId?: string } = {},
): Promise<CreateConversationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const machine = target.machineName.trim() || "The desktop";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CONVERSATION_CREATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}${TAILNET_MCP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.deviceToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: options.requestId ?? `chat-${Date.now().toString(36)}`,
        method: "tools/call",
        params: { name: "conversation.create", arguments: buildConversationCreateArgs(input) },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    // A minute is long past a healthy start, but the desktop may still have
    // started it: say where it would be rather than that it failed.
    if (controller.signal.aborted || (isRecord(error) && error.name === "AbortError")) {
      return { ok: false, failure: "unavailable", title: `${machine} took too long to start the chat.`, message: "If it started, it is under Chats." };
    }
    return { ok: false, failure: "unavailable", title: `${machine} did not answer.`, message: "Is Tailscale up on both devices?" };
  }
  clearTimeout(timer);
  const body = (await response.json().catch(() => null)) as unknown;
  return readConversationCreateAnswer(response.status, body, target.machineName);
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
