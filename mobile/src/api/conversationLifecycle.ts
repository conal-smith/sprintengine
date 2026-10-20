import type { ApiResult } from "./types";
import { createGatewayToolCaller } from "./tailnetWorkspaces";

// Settling a chat and saying it was seen: the gateway's `conversation.settle`
// and `conversation.visit` tools, from a desktop that advertises
// `conversation-lifecycle`, over the same stateless JSON-RPC POST
// `workspace.list` rides. Both act on a workspace, which on the desktop is one
// chat: settling it moves it to the sidebar's Settled shelf and off every
// list, and a visit tells the desktop a person had it on screen, so a turn
// read here stops showing as finished-and-unseen there too. A desktop that
// also advertises `chat-mark-unread` takes `conversation.mark_unread`, the
// one call that moves the visit clock back: to just before the chat's latest
// finish, so that finish reads as unseen again on every device.
//
// What is sent and what an answer means are pure and exported, so the
// regression suite reads the same rules the screens run.

/** A settle waits on the desktop writing the chat's state; a visit is a stamp and no more. */
export const CONVERSATION_SETTLE_TIMEOUT_MS = 10_000;
export const CONVERSATION_VISIT_TIMEOUT_MS = 5_000;
/** Mark unread writes the desktop's record of the chat, as a settle does. */
export const CONVERSATION_MARK_UNREAD_TIMEOUT_MS = 10_000;

export interface SettledConversation {
  workspaceId: string;
  /** When the desktop settled it; null when the call un-settled it. */
  settledAt: number | null;
}

export interface VisitedConversation {
  workspaceId: string;
  /** The desktop's visit clock after the stamp; it only moves forward. */
  lastVisitedAt: number;
}

export interface MarkedUnreadConversation {
  workspaceId: string;
  /** The desktop's visit clock after the mark: just before the chat's latest finish, or earlier still. */
  lastVisitedAt: number;
}

/** What the chat surfaces need from the tools; a harness may supply a fake of the same shape. */
export interface ConversationLifecycleApi {
  settle(workspaceId: string, settled?: boolean): Promise<ApiResult<SettledConversation>>;
  /** No instant is sent: the desktop stamps its own clock, the one its turn ends are on. */
  visit(workspaceId: string): Promise<ApiResult<VisitedConversation>>;
  /**
   * Only for a desktop that advertises `chat-mark-unread`. Refused as
   * `nothing_finished` when no agent in the chat has finished anything; the
   * refusal's message is the desktop's own.
   */
  markUnread(workspaceId: string): Promise<ApiResult<MarkedUnreadConversation>>;
}

/** `conversation.settle`'s arguments. `settled` is sent only to un-settle; the tool's default settles. */
export function buildSettleArgs(workspaceId: string, settled = true): Record<string, unknown> {
  return settled ? { workspaceId } : { workspaceId, settled: false };
}

/**
 * `conversation.settle`'s answer, or null when it is not the tool's shape: a
 * desktop that said ok without naming the chat, or named another, did not
 * settle the one asked about as far as the phone can tell.
 */
export function readSettleAnswer(data: unknown, workspaceId: string): SettledConversation | null {
  if (!isRecord(data) || data.ok !== true || data.workspaceId !== workspaceId) return null;
  const at = data.settledAt;
  if (at === null) return { workspaceId, settledAt: null };
  return instant(at) ? { workspaceId, settledAt: at } : null;
}

/** `conversation.visit`'s answer, or null when it is not the tool's shape. */
export function readVisitAnswer(data: unknown, workspaceId: string): VisitedConversation | null {
  if (!isRecord(data) || data.ok !== true || data.workspaceId !== workspaceId) return null;
  return instant(data.lastVisitedAt) ? { workspaceId, lastVisitedAt: data.lastVisitedAt } : null;
}

/** `conversation.mark_unread`'s answer, or null when it is not the tool's shape. */
export function readMarkUnreadAnswer(data: unknown, workspaceId: string): MarkedUnreadConversation | null {
  if (!isRecord(data) || data.ok !== true || data.workspaceId !== workspaceId) return null;
  return instant(data.lastVisitedAt) ? { workspaceId, lastVisitedAt: data.lastVisitedAt } : null;
}

export function createConversationLifecycleApi(options: { baseUrl: string; deviceToken: string }): ConversationLifecycleApi {
  const callTool = createGatewayToolCaller(options);
  return {
    async settle(workspaceId, settled = true) {
      const result = await callTool("conversation.settle", buildSettleArgs(workspaceId, settled), CONVERSATION_SETTLE_TIMEOUT_MS);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      const answer = readSettleAnswer(result.data, workspaceId);
      return answer
        ? { ok: true as const, data: answer }
        : { ok: false as const, errorCode: "invalid_payload" as const, message: "The desktop did not confirm the chat was settled." };
    },
    async visit(workspaceId) {
      const result = await callTool("conversation.visit", { workspaceId }, CONVERSATION_VISIT_TIMEOUT_MS);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      const answer = readVisitAnswer(result.data, workspaceId);
      return answer
        ? { ok: true as const, data: answer }
        : { ok: false as const, errorCode: "invalid_payload" as const, message: "The desktop did not confirm the visit." };
    },
    async markUnread(workspaceId) {
      const result = await callTool("conversation.mark_unread", { workspaceId }, CONVERSATION_MARK_UNREAD_TIMEOUT_MS);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      const answer = readMarkUnreadAnswer(result.data, workspaceId);
      return answer
        ? { ok: true as const, data: answer }
        : { ok: false as const, errorCode: "invalid_payload" as const, message: "The desktop did not confirm the chat was marked unread." };
    },
  };
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
