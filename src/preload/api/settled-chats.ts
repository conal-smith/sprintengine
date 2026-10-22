import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi, SettledChatDeletionOutcome, SettledChatDeletionPlan } from '../../shared/electron-api'

export const settledChatsApi = {
  planSettledChatDeletion: (workspaceIds: string[]): Promise<SettledChatDeletionPlan[]> =>
    ipcRenderer.invoke('settled-chats:plan-delete', workspaceIds),
  deleteSettledChats: (workspaceIds: string[]): Promise<SettledChatDeletionOutcome[]> =>
    ipcRenderer.invoke('settled-chats:delete', workspaceIds),
} satisfies Pick<ElectronApi, 'planSettledChatDeletion' | 'deleteSettledChats'>
