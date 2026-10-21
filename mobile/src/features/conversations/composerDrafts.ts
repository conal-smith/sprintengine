// What the person had typed into a chat's box and not sent, kept per chat so
// leaving the chat, or the app being closed, does not throw it away. A phone
// is put down mid-sentence more often than a desktop is: a call comes in, the
// OS reclaims the app in the background, the person checks another chat. A
// half-written message lost to any of those has to be typed again from
// memory, so the box's words outlive the screen that holds them.
//
// Only the words: pictures are uploads tied to the session they were made
// for, and are not worth holding past it.

import { CONVERSATION_MAX_MESSAGE_CHARS } from "../../api/conversationWire";

export type ComposerDraft = { text: string; at: number };
export type ComposerDrafts = Record<string, ComposerDraft>;

/** The most chats a phone keeps drafts for; the oldest go first. */
export const MAX_DRAFTS = 50;
/** A draft left this long is not coming back. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** A draft is kept up to the longest message the desktop takes. */
export const MAX_DRAFT_LENGTH = CONVERSATION_MAX_MESSAGE_CHARS;

/** One key per chat on one desktop. */
export const draftKey = (chat: { deviceId: string; workspaceId: string; agentId: string }) =>
  `${chat.deviceId}\u0000${chat.workspaceId}\u0000${chat.agentId}`;

/** Whatever was read from disk, as drafts: anything malformed or expired is dropped. */
export function normalizeDrafts(raw: unknown, now: number): ComposerDrafts {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const drafts: ComposerDrafts = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || !text.trim() || typeof at !== "number" || !Number.isFinite(at)) continue;
    if (now - at > DRAFT_MAX_AGE_MS) continue;
    drafts[key] = { text: text.slice(0, MAX_DRAFT_LENGTH), at };
  }
  return keepNewest(drafts);
}

/**
 * The drafts with `key`'s set to `text`: a box emptied (sent, or cleared by
 * hand) forgets its draft. The same drafts back when nothing changed, so a
 * caller can tell that there is nothing to write.
 */
export function withDraft(drafts: ComposerDrafts, key: string, text: string, now: number): ComposerDrafts {
  const kept = text.slice(0, MAX_DRAFT_LENGTH);
  if (!kept.trim()) {
    if (!(key in drafts)) return drafts;
    const next = { ...drafts };
    delete next[key];
    return next;
  }
  if (drafts[key]?.text === kept) return drafts;
  return keepNewest({ ...drafts, [key]: { text: kept, at: now } });
}

function keepNewest(drafts: ComposerDrafts): ComposerDrafts {
  const keys = Object.keys(drafts);
  if (keys.length <= MAX_DRAFTS) return drafts;
  const newest = keys.sort((a, b) => drafts[b].at - drafts[a].at).slice(0, MAX_DRAFTS);
  return Object.fromEntries(newest.map((key) => [key, drafts[key]]));
}
