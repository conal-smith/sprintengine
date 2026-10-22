import type { IpcMain } from 'electron'

import type { SettledChatDeletionOutcome, SettledChatDeletionPlan } from '../../shared/ipc/settled-chats'
import type { SettledChatDeletion } from '../settled-chat-deletion'

/**
 * The windows' side of deleting settled chats: what a delete would do (for
 * the confirmation), and the delete. Main's alone, beside the worktree pool
 * it gives worktrees back to; a window never removes a chat's files itself.
 */

/** More than any page asks for at once; a bigger list is a fault, not a request. */
const MAX_CHATS = 2_000

function chatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  return [...new Set(ids)].slice(0, MAX_CHATS)
}

export function registerSettledChatsIpc(ipcMain: IpcMain, deletion: SettledChatDeletion): void {
  ipcMain.handle('settled-chats:plan-delete', async (_, workspaceIds: unknown): Promise<SettledChatDeletionPlan[]> =>
    deletion.plan(chatIds(workspaceIds)),
  )
  ipcMain.handle('settled-chats:delete', async (_, workspaceIds: unknown): Promise<SettledChatDeletionOutcome[]> =>
    deletion.delete(chatIds(workspaceIds)),
  )
}
