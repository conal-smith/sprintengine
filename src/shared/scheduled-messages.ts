// A message a person wrote in an open chat and asked to go out later: at a
// time they picked, into that chat, as if they had pressed Send then. Main
// keeps them (src/main/scheduled-messages/scheduled-messages.ts) and sends
// them through the chat's own send path, which brings back an agent that is
// no longer running; the chat's composer tray draws its own
// (agentChat/scheduledMessages.tsx).
//
// What a scheduled message carries is the text alone: a picture or a file
// attached by path belongs to the moment it was attached, and is not kept on
// this computer's disk for later. A message a paired machine queued for a
// turn's end is the exception: that machine handed over its pictures and files
// with it, which this computer keeps until the message goes (`carries`).

import { isRecord } from './records'
import {
  isProviderWideUsageWindow,
  USAGE_LIMIT_PROVIDERS,
  type UsageLimitProvider,
  type UsageLimitSnapshot,
} from './usage-limits'

/** A chat by its identity: the agent record it is, in the workspace that holds it. */
export type ScheduledMessageChat = { workspaceId: string; agentId: string }

export type ScheduledMessage = ScheduledMessageChat & {
  id: string
  text: string
  /** When it goes out (epoch ms). */
  sendAt: number
  createdAt: number
  /**
   * Held for the end of the chat's turn rather than for a time: a message a
   * paired machine's composer queued while this chat was working, handed
   * here so it goes even once that machine sleeps or closes. It went due when
   * it was held, so it waits on the turn from the start.
   */
  queued?: true
  /**
   * Sent once this provider's usage limit has lifted, rather than at a time
   * the person picked: `sendAt` is the reset as it was known when it was
   * scheduled, and when that comes the limit is asked again, so a window that
   * resets later (a weekly one behind the session's) moves it to that reset.
   */
  untilLimitReset?: UsageLimitProvider
  /**
   * What a held message carries beside its words: its pictures and files by
   * name (kept on this disk until it goes), its skills by id, and the files
   * and folders of the chat's folder it mentions. Absent for one that carries
   * nothing, and for every message scheduled for a time.
   */
  carries?: ScheduledMessageCarries
  /**
   * It came due while the chat was working, and waits for the turn to end
   * (epoch ms it first came due). Absent while it is still ahead.
   */
  waitingSince?: number
  /** It is on its way into the chat now. Never kept in the file. */
  sending?: true
  /**
   * It went out and the chat refused it, in the chat's words. It stays, saying
   * so, until Retry, Edit or Delete; nothing is scheduled.
   */
  failure?: string
}

/** What a held message carries, as a tray names it; each list absent when empty. */
export type ScheduledMessageCarries = {
  images?: string[]
  files?: string[]
  skills?: string[]
  mentions?: Array<{ path: string; kind: 'file' | 'folder'; line?: number; endLine?: number }>
}

export type ScheduledMessagesState = { messages: ScheduledMessage[] }

/**
 * What a window asks: schedule a message into a chat, move one to another
 * time, send one now (a failed one included), or delete one.
 */
export type ScheduledMessageUpdate =
  | (ScheduledMessageChat & {
      kind: 'schedule'
      text: string
      sendAt: number
      untilLimitReset?: UsageLimitProvider
    })
  | { kind: 'reschedule'; id: string; sendAt: number }
  | { kind: 'send-now'; id: string }
  | { kind: 'delete'; id: string }

export const SCHEDULED_MESSAGES_GET_CHANNEL = 'scheduled-messages:get'
export const SCHEDULED_MESSAGES_UPDATE_CHANNEL = 'scheduled-messages:update'
export const SCHEDULED_MESSAGES_CHANGED_CHANNEL = 'scheduled-messages:changed'
/**
 * A message a window's own chat queued while its turn ran, held by main and
 * sent from there when the turn ends, as a paired machine's queued message
 * is: the window's state is gone with a reload or a crash, main's file is not.
 */
export const SCHEDULED_MESSAGES_HOLD_CHANNEL = 'scheduled-messages:hold'

export type ScheduledMessageHoldRequest = ScheduledMessageChat & {
  text: string
  /** The window's own id for the message, so a retried ask holds it once. */
  source: string
}

export type ScheduledMessageHoldAnswer = { ok: true; id: string } | { ok: false; reason: string }

/** A hold as a window asked for it, or null for anything else. */
export function parseScheduledMessageHold(input: unknown): ScheduledMessageHoldRequest | null {
  if (!isRecord(input) || !isId(input.workspaceId) || !isId(input.agentId) || !isId(input.source)) return null
  if (typeof input.text !== 'string') return null
  const text = input.text.trim()
  if (!text || text.length > MAX_SCHEDULED_MESSAGE_LENGTH) return null
  return { workspaceId: input.workspaceId, agentId: input.agentId, text, source: input.source }
}

/** Ids are minted by the app and short; this only keeps a strange one out. */
const MAX_ID_LENGTH = 200
/** A message is a turn a person typed; this keeps a pasted novel out of a small file. */
export const MAX_SCHEDULED_MESSAGE_LENGTH = 100_000

/** An update as a window sent it, or null for anything else. */
export function parseScheduledMessageUpdate(input: unknown): ScheduledMessageUpdate | null {
  if (!isRecord(input)) return null
  if (input.kind === 'schedule') {
    if (!isId(input.workspaceId) || !isId(input.agentId) || !isTime(input.sendAt)) return null
    if (typeof input.text !== 'string') return null
    const text = input.text.trim()
    if (!text || text.length > MAX_SCHEDULED_MESSAGE_LENGTH) return null
    const untilLimitReset = USAGE_LIMIT_PROVIDERS.find((provider) => provider === input.untilLimitReset)
    return {
      kind: 'schedule',
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      text,
      sendAt: input.sendAt,
      ...(untilLimitReset ? { untilLimitReset } : {}),
    }
  }
  if (!isId(input.id)) return null
  if (input.kind === 'reschedule')
    return isTime(input.sendAt) ? { kind: 'reschedule', id: input.id, sendAt: input.sendAt } : null
  if (input.kind === 'send-now' || input.kind === 'delete') return { kind: input.kind, id: input.id }
  return null
}

/**
 * After a limit's reset, how long a message waiting on it waits more: the
 * provider's clock and this computer's can disagree by seconds, and a turn
 * sent on the stroke of the reset can still be refused.
 */
export const LIMIT_RESET_SEND_BUFFER_MS = 60_000

/**
 * When a message to go once the provider's limit lifts would go, from what the
 * provider last said: after the latest reset of the account-wide windows at
 * their limit, or, with none at its limit, of the soonest one ahead. Null when
 * no window says when it resets.
 */
export function limitResetSendAt(snapshot: UsageLimitSnapshot | null, now: number): number | null {
  const ahead = (snapshot?.windows ?? []).filter(
    (window) => isProviderWideUsageWindow(window) && window.resetsAt !== null && window.resetsAt > now,
  )
  const limited = ahead.filter((window) => window.status === 'rejected')
  const resets = (limited.length ? limited : ahead).map((window) => window.resetsAt!)
  if (!resets.length) return null
  const reset = limited.length ? Math.max(...resets) : Math.min(...resets)
  return reset + LIMIT_RESET_SEND_BUFFER_MS
}

/** The chat's scheduled messages, soonest first. */
export function selectChatScheduledMessages(
  state: ScheduledMessagesState | null,
  chat: ScheduledMessageChat,
): ScheduledMessage[] {
  return (state?.messages ?? [])
    .filter((message) => message.workspaceId === chat.workspaceId && message.agentId === chat.agentId)
    .sort((a, b) => a.sendAt - b.sendAt)
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
