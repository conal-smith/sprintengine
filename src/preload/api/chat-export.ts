import { ipc as ipcRenderer } from '../ipc-router'
import { CHAT_EXPORT_CHANNEL, type ChatExportInput, type ChatExportResult } from '../../shared/chat-export'
import type { ElectronApi } from '../../shared/electron-api'

export const chatExportApi = {
  exportChat: (input: ChatExportInput): Promise<ChatExportResult> => ipcRenderer.invoke(CHAT_EXPORT_CHANNEL, input),
} satisfies Pick<ElectronApi, 'exportChat'>
