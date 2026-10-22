import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'

export const htmlPreviewApi = {
  htmlPreviewOpen: (html: string): Promise<string> => ipcRenderer.invoke('html-preview:open', html),
  htmlPreviewClose: (url: string): Promise<void> => ipcRenderer.invoke('html-preview:close', url),
} satisfies Pick<ElectronApi, 'htmlPreviewOpen' | 'htmlPreviewClose'>
