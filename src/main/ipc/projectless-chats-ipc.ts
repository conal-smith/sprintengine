import type { IpcMain } from 'electron'

import { createProjectlessChatFolder, ensureProjectlessChatsRoot } from '../projectless-chat-folders'

export function registerProjectlessChatsIpc(ipcMain: IpcMain): void {
  // New chat's "No project": the root the door is scoped to while it is open.
  ipcMain.handle('chats:projectless-root', (): Promise<string> => ensureProjectlessChatsRoot())
  // The folder one chat started without a project runs in, named after its first words.
  ipcMain.handle('chats:projectless-folder:create', (_event, prompt?: unknown): Promise<string> =>
    createProjectlessChatFolder(typeof prompt === 'string' ? prompt : null),
  )
}
