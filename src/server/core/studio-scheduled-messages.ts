import { join } from 'node:path'

import { CONVERSATION_MAX_SCHEDULED_MESSAGES } from '../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type {
  ConversationGatewayHost,
  ConversationHeldMessages,
  ConversationScheduledSends,
} from '../../main/automation/tailnet/tailnet-conversation-host'
import {
  createScheduledMessages,
  SCHEDULED_MESSAGES_FILE,
  scheduledMessagesFileStorage,
  type ScheduledMessages,
  type ScheduledMessagesStorage,
} from '../../main/scheduled-messages/scheduled-messages'

// The Studio core's scheduled messages (main/scheduled-messages), wired to
// what the core holds: its chats and their events, the registry's records, and
// a conversation host whose sends are the person's own. Kept apart from the
// core's composition so the wiring is tested as the core builds it.

/** The client a scheduled message is sent as, for the runtime's command receipts. */
export const STUDIO_SCHEDULED_MESSAGE_CLIENT_ID = 'studio-scheduled-message'

export type StudioScheduledMessagesDeps = {
  dataDir: string
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
    onEvent(listener: (event: ConversationEvent) => void): () => void
  }
  /** A workspace's record: the agents (chats) it holds. */
  workspaceRecord: (workspaceId: string) => { agents: Record<string, unknown> } | null
  /** A conversation host whose sends are recorded as the person's. */
  createHost: () => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  storage?: ScheduledMessagesStorage
  now?: () => number
  log?: (message: string) => void
}

export function createStudioScheduledMessages(deps: StudioScheduledMessagesDeps): ScheduledMessages {
  let host: ReturnType<StudioScheduledMessagesDeps['createHost']> | null = null
  return createScheduledMessages({
    storage: deps.storage ?? scheduledMessagesFileStorage(join(deps.dataDir, SCHEDULED_MESSAGES_FILE)),
    listSessions: () => {
      const listed = deps.conversations.listSessions()
      return listed.ok ? listed.sessions : []
    },
    onConversationEvent: (listener) => deps.conversations.onEvent(listener),
    chatExists: ({ workspaceId, agentId }) => {
      const record = deps.workspaceRecord(workspaceId)
      return Boolean(record && Object.hasOwn(record.agents, agentId))
    },
    // Through the same send a paired device's goes, which resumes a chat with
    // no live session from its record. No origin: the words are the person's,
    // and the chat counts them as their last message.
    send: async (chat, text, commandId) => {
      host ??= deps.createHost()
      const key = host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      return host.command(key, STUDIO_SCHEDULED_MESSAGE_CLIENT_ID, commandId, { kind: 'send', message: text })
    },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}

/**
 * The scheduled messages as the conversation host's held messages: what a
 * paired machine queued in a chat here while its turn ran is held among them,
 * so it goes from this machine when the turn ends, shows in this chat's tray
 * beside the ones scheduled here, and outlives a restart. Read through
 * `scheduled` at each call, since the hosts are made before they are.
 */
export function studioHeldMessages(scheduled: () => ScheduledMessages): ConversationHeldMessages {
  const heldIn = (chat: { workspaceId: string; agentId: string }) =>
    scheduled()
      .state()
      .messages.filter(
        (message) => message.queued && message.workspaceId === chat.workspaceId && message.agentId === chat.agentId,
      )
  return {
    hold(chat, text, source) {
      const held = scheduled().hold(chat, text, source)
      return held.ok ? { ok: true } : { ok: false, message: held.reason }
    },
    cancel(chat, id) {
      const message = heldIn(chat).find((entry) => entry.id === id)
      if (!message) return { ok: false, message: 'That message is no longer queued: it was sent or taken back.' }
      if (message.sending) return { ok: false, message: 'That message is already on its way into the chat.' }
      scheduled().update({ kind: 'delete', id })
      return { ok: true }
    },
    list(chat) {
      return heldIn(chat)
        .filter((message) => !message.sending)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((message) => ({
          id: message.id,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.failure !== undefined ? { failure: message.failure } : {}),
        }))
    },
    onChanged(listener) {
      return scheduled().onChanged(() => listener())
    },
  }
}

/**
 * The scheduled messages as the conversation host's scheduled sends: what a
 * paired machine schedules into a chat here for a time is kept among them, so
 * it goes from this machine at its time, shows in this chat's tray beside the
 * ones scheduled here, and outlives a restart. The ones a paired machine
 * queued for the turn's end are `studioHeldMessages`'s, and are left out.
 * Read through `scheduled` at each call, as `studioHeldMessages` is.
 */
export function studioScheduledSends(scheduled: () => ScheduledMessages): ConversationScheduledSends {
  const scheduledIn = (chat: { workspaceId: string; agentId: string }) =>
    scheduled()
      .state()
      .messages.filter(
        (message) => !message.queued && message.workspaceId === chat.workspaceId && message.agentId === chat.agentId,
      )
  const gone = { ok: false as const, message: 'That message is no longer scheduled: it was sent or deleted.' }
  return {
    schedule(chat, text, sendAt, source) {
      const kept = scheduled().scheduleFrom(chat, text, sendAt, source)
      return kept.ok ? { ok: true } : { ok: false, message: kept.reason }
    },
    sendNow(chat, id) {
      const message = scheduledIn(chat).find((entry) => entry.id === id)
      if (!message) return gone
      if (message.sending) return { ok: false, message: 'That message is already on its way into the chat.' }
      scheduled().update({ kind: 'send-now', id })
      return { ok: true }
    },
    cancel(chat, id) {
      const message = scheduledIn(chat).find((entry) => entry.id === id)
      if (!message) return gone
      if (message.sending) return { ok: false, message: 'That message is already on its way into the chat.' }
      scheduled().update({ kind: 'delete', id })
      return { ok: true }
    },
    list(chat) {
      return scheduledIn(chat)
        .sort((a, b) => a.sendAt - b.sendAt)
        .slice(0, CONVERSATION_MAX_SCHEDULED_MESSAGES)
        .map((message) => ({
          id: message.id,
          text: message.text,
          sendAt: message.sendAt,
          createdAt: message.createdAt,
          ...(message.waitingSince !== undefined ? { waitingSince: message.waitingSince } : {}),
          ...(message.sending ? { sending: true as const } : {}),
          ...(message.failure !== undefined ? { failure: message.failure } : {}),
        }))
    },
    onChanged(listener) {
      return scheduled().onChanged(() => listener())
    },
  }
}
