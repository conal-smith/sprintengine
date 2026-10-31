import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import {
  SCHEDULED_MESSAGES_CHANGED_CHANNEL,
  SCHEDULED_MESSAGES_GET_CHANNEL,
  SCHEDULED_MESSAGES_HOLD_CHANNEL,
  type ScheduledMessageHoldAnswer,
  type ScheduledMessageHoldRequest,
  SCHEDULED_MESSAGES_UPDATE_CHANNEL,
  type ScheduledMessagesState,
  type ScheduledMessageUpdate,
} from '../../shared/scheduled-messages'

// `onScheduledMessagesChanged` returns the unsubscribe, so a window can let go
// of the push when no chat in it is on screen any more.
export const scheduledMessagesApi = {
  scheduledMessages: (): Promise<ScheduledMessagesState> => ipcRenderer.invoke(SCHEDULED_MESSAGES_GET_CHANNEL),
  updateScheduledMessage: (update: ScheduledMessageUpdate): Promise<ScheduledMessagesState> =>
    ipcRenderer.invoke(SCHEDULED_MESSAGES_UPDATE_CHANNEL, update),
  holdQueuedMessage: (request: ScheduledMessageHoldRequest): Promise<ScheduledMessageHoldAnswer> =>
    ipcRenderer.invoke(SCHEDULED_MESSAGES_HOLD_CHANNEL, request),
  onScheduledMessagesChanged: (listener: (state: ScheduledMessagesState) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, state: ScheduledMessagesState): void => listener(state)
    ipcRenderer.on(SCHEDULED_MESSAGES_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(SCHEDULED_MESSAGES_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  'scheduledMessages' | 'updateScheduledMessage' | 'holdQueuedMessage' | 'onScheduledMessagesChanged'
>
