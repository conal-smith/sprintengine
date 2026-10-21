import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'

export const clipboardApi = {
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write-text', text),
  clipboardWriteRich: (payload: { text: string; html: string }): Promise<void> =>
    ipcRenderer.invoke('clipboard:write-rich', { text: payload.text, html: payload.html }),
} satisfies Pick<ElectronApi, 'clipboardReadText' | 'clipboardWriteText' | 'clipboardWriteRich'>
