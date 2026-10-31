import type { IpcMain } from 'electron'

import {
  parseScheduledMessageHold,
  parseScheduledMessageUpdate,
  SCHEDULED_MESSAGES_HOLD_CHANNEL,
  type ScheduledMessageHoldAnswer,
  SCHEDULED_MESSAGES_CHANGED_CHANNEL,
  SCHEDULED_MESSAGES_GET_CHANNEL,
  SCHEDULED_MESSAGES_UPDATE_CHANNEL,
  type ScheduledMessagesState,
} from '../../shared/scheduled-messages'
import type { ScheduledMessages } from '../scheduled-messages/scheduled-messages'

/** The slice of a renderer's webContents the push touches. */
type SubscriberLike = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
  once: (event: 'destroyed', listener: () => void) => unknown
}

/**
 * `scheduled-messages:get` answers with every chat's scheduled messages; every
 * change after that is pushed to each window that asked.
 * `scheduled-messages:update` schedules, moves, sends or deletes one, and
 * answers with the state after it.
 */
export function registerScheduledMessagesIpc(
  ipcMain: IpcMain,
  scheduledMessages: ScheduledMessages,
): { stop: () => void } {
  const subscribers = new Map<number, SubscriberLike>()
  const subscribe = (event: unknown): void => {
    const sender = (event as { sender?: SubscriberLike } | null)?.sender
    if (sender && !subscribers.has(sender.id) && !sender.isDestroyed()) {
      subscribers.set(sender.id, sender)
      sender.once('destroyed', () => subscribers.delete(sender.id))
    }
  }
  ipcMain.handle(SCHEDULED_MESSAGES_GET_CHANNEL, (event) => {
    subscribe(event)
    return scheduledMessages.state()
  })
  ipcMain.handle(SCHEDULED_MESSAGES_UPDATE_CHANNEL, (_event, input: unknown) => {
    const update = parseScheduledMessageUpdate(input)
    return update ? scheduledMessages.update(update) : scheduledMessages.state()
  })
  // A window's own queued message, held here under the window's id for it
  // (`window:` keeps it apart from a paired machine's command ids).
  ipcMain.handle(SCHEDULED_MESSAGES_HOLD_CHANNEL, (_event, input: unknown): ScheduledMessageHoldAnswer => {
    const hold = parseScheduledMessageHold(input)
    if (!hold) return { ok: false, reason: 'The message to hold is not one this computer can keep.' }
    const held = scheduledMessages.hold(
      { workspaceId: hold.workspaceId, agentId: hold.agentId },
      hold.text,
      `window:${hold.source}`,
    )
    return held.ok ? { ok: true, id: held.id } : { ok: false, reason: held.reason }
  })
  const stopRelay = scheduledMessages.onChanged((state: ScheduledMessagesState) => {
    for (const [id, sender] of subscribers) {
      if (sender.isDestroyed()) subscribers.delete(id)
      else sender.send(SCHEDULED_MESSAGES_CHANGED_CHANNEL, state)
    }
  })
  return {
    stop: () => {
      stopRelay()
      subscribers.clear()
    },
  }
}
