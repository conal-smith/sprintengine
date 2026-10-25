import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { CONVERSATION_MAX_SCHEDULED_MESSAGES } from '../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { ConversationCommand } from '../../../packages/conversation-protocol/src/public'
import type {
  ConversationGatewayHost,
  ConversationHeldAttachments,
  ConversationHeldMessages,
  ConversationHeldSend,
  ConversationScheduledSends,
} from '../../main/automation/tailnet/tailnet-conversation-host'
import {
  createScheduledMessages,
  SCHEDULED_MESSAGES_FILE,
  scheduledMessagesFileStorage,
  type ScheduledMessageCarried,
  type ScheduledMessages,
  type ScheduledMessagesStorage,
} from '../../main/scheduled-messages/scheduled-messages'
import {
  holdTailnetUpload,
  releaseTailnetUpload,
  TAILNET_UPLOADS_DIRNAME,
} from '../../main/automation/tailnet/tailnet-file-uploads'

// The Studio core's scheduled messages (main/scheduled-messages), wired to
// what the core holds: its chats and their events, the registry's records, and
// a conversation host whose sends are the person's own. Kept apart from the
// core's composition so the wiring is tested as the core builds it.

/** The client a scheduled message is sent as, for the runtime's command receipts. */
export const STUDIO_SCHEDULED_MESSAGE_CLIENT_ID = 'studio-scheduled-message'

/**
 * Where the pictures a held message carries are copied when it is held, one
 * folder per message held: under the data directory, beside the scheduled
 * messages' file, and removed once the message has gone.
 */
export const HELD_MESSAGE_PICTURES_DIRNAME = 'held-message-pictures'

/** The folder a held picture's copy is in, when it is one of ours; null for any other path. */
function heldPictureFolder(dataDir: string, path: string): string | null {
  const root = join(dataDir, HELD_MESSAGE_PICTURES_DIRNAME)
  const inside = relative(root, path)
  if (!inside || isAbsolute(inside) || inside.startsWith('..')) return null
  const [folder] = inside.split(/[\\/]/u)
  return folder ? join(root, folder) : null
}

/**
 * Let go of what a held message carried once it has gone: its pictures'
 * copies always, and its files only when it was not sent, since a sent one's
 * are the message's (tailnet-file-uploads.ts). Only paths under Studio's own
 * folders are touched.
 */
function releaseCarried(dataDir: string, carried: ScheduledMessageCarried, sent: boolean, log?: (m: string) => void) {
  const folders = new Set(carried.images?.flatMap((image) => heldPictureFolder(dataDir, image.path) ?? []))
  for (const folder of folders) void rm(folder, { recursive: true, force: true }).catch(() => undefined)
  for (const file of carried.files ?? [])
    try {
      releaseTailnetUpload(join(dataDir, TAILNET_UPLOADS_DIRNAME), file.path, sent)
    } catch (error) {
      log?.(`A held message's file was not let go: ${error instanceof Error ? error.message : String(error)}`)
    }
}

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
    // and the chat counts them as their last message. A held message's
    // pictures and files go from where they are kept here, and its skills and
    // mentions as a device's send names them.
    send: async (chat, text, commandId, carried) => {
      host ??= deps.createHost()
      const key = host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      const [command, held] = heldMessageSend(text, carried)
      return host.command(key, STUDIO_SCHEDULED_MESSAGE_CLIENT_ID, commandId, command, undefined, held)
    },
    release: (carried, sent) => releaseCarried(deps.dataDir, carried, sent, deps.log),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}

/**
 * The send a held message goes as: its words, skills and mentions as a
 * device's send names them, and its pictures and files from where they are
 * kept on this disk, which only this machine's own sends may name.
 */
export function heldMessageSend(
  text: string,
  carried: ScheduledMessageCarried | undefined,
): [Extract<ConversationCommand, { kind: 'send' }>, ConversationHeldSend | undefined] {
  const command = {
    kind: 'send' as const,
    message: text,
    ...(carried?.skills?.length ? { skills: [...carried.skills] } : {}),
    ...(carried?.mentions?.length ? { mentions: carried.mentions.map((mention) => ({ ...mention })) } : {}),
  }
  if (!carried?.images?.length && !carried?.files?.length) return [command, undefined]
  return [
    command,
    {
      images: (carried.images ?? []).map((image) => ({ ...image })),
      files: (carried.files ?? []).map((file) => ({ path: file.path, bytes: file.bytes })),
    },
  ]
}

/**
 * The scheduled messages as the conversation host's held messages: what a
 * paired machine queued in a chat here while its turn ran is held among them,
 * so it goes from this machine when the turn ends, shows in this chat's tray
 * beside the ones scheduled here, and outlives a restart. Read through
 * `scheduled` at each call, since the hosts are made before they are.
 *
 * What one carries is made this machine's before it is answered
 * (`conversation-queued-attachments`): its pictures are copied under
 * `dataDir` (an upload's staged copy goes within the hour), and its files'
 * upload folders are marked held, so the week's pruning passes them by while
 * the message waits. A command held already keeps nothing new.
 */
export function studioHeldMessages(scheduled: () => ScheduledMessages, dataDir: string): ConversationHeldMessages {
  const heldIn = (chat: { workspaceId: string; agentId: string }) =>
    scheduled()
      .state()
      .messages.filter(
        (message) => message.queued && message.workspaceId === chat.workspaceId && message.agentId === chat.agentId,
      )
  const uploadsRoot = join(dataDir, TAILNET_UPLOADS_DIRNAME)
  return {
    async hold(chat, text, source, attachments) {
      if (!attachments || (!attachments.images.length && !attachments.files.length)) {
        const held = scheduled().hold(chat, text, source, attachments && carriedWords(attachments))
        return held.ok ? { ok: true } : { ok: false, message: held.reason }
      }
      if (scheduled().heldFrom(source) !== null) return { ok: true }
      const folder = join(dataDir, HELD_MESSAGE_PICTURES_DIRNAME, randomUUID())
      let carried: ScheduledMessageCarried
      try {
        const images: NonNullable<ScheduledMessageCarried['images']> = []
        if (attachments.images.length) await mkdir(folder, { recursive: true, mode: 0o700 })
        for (const [index, image] of attachments.images.entries()) {
          const path = join(folder, String(index))
          await writeFile(path, image.bytes, { mode: 0o600 })
          images.push({ path, name: image.name, mediaType: image.mediaType, bytes: image.bytes.length })
        }
        // Marked where it is one of the device uploads Studio prunes; any other
        // path is not Studio's to prune, or to remove.
        for (const file of attachments.files) holdTailnetUpload(uploadsRoot, file.path)
        carried = { ...carriedWords(attachments), images, files: attachments.files.map((file) => ({ ...file })) }
      } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined)
        return {
          ok: false,
          message: `The message could not be kept here: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const held = scheduled().hold(chat, text, source, carried)
      // Refused, or held already under this command: what was made for it goes.
      if (!held.ok || held.repeat) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined)
        if (!held.ok)
          for (const file of attachments.files) {
            try {
              releaseTailnetUpload(uploadsRoot, file.path, true)
            } catch {
              // Pruned with the week's others instead.
            }
          }
      }
      return held.ok ? { ok: true } : { ok: false, message: held.reason }
    },
    heldBefore(source) {
      return scheduled().heldFrom(source) !== null
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
          ...message.carries,
        }))
    },
    onChanged(listener) {
      return scheduled().onChanged(() => listener())
    },
  }
}

/** The skills and mentions a held message carries, which need nothing kept on disk. */
function carriedWords(attachments: Pick<ConversationHeldAttachments, 'skills' | 'mentions'>) {
  return {
    ...(attachments.skills.length ? { skills: [...attachments.skills] } : {}),
    ...(attachments.mentions.length ? { mentions: attachments.mentions.map((mention) => ({ ...mention })) } : {}),
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
