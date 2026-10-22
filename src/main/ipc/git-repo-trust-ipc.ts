// The banner on a project whose repository's own git config names programs:
// what it names, and the person's answer. An answer is broadcast, so every
// window showing that project drops its banner together.

import { BrowserWindow, type IpcMain } from 'electron'

import type { GitRepoTrustDecision, GitRepoTrustView } from '../../shared/ipc/git-repo-trust'
import type { GitRepoTrust } from '../git-repo-trust'

const GET_CHANNEL = 'git-repo-trust:get'
const ANSWER_CHANNEL = 'git-repo-trust:answer'
const CHANGED_CHANNEL = 'git-repo-trust:changed'

export function registerGitRepoTrustIpc(
  ipcMain: IpcMain,
  trust: GitRepoTrust,
  deps: { getWindows?: () => BrowserWindow[] } = {},
): void {
  const getWindows = deps.getWindows ?? (() => BrowserWindow.getAllWindows())

  ipcMain.handle(GET_CHANNEL, async (_, folderPath: unknown): Promise<GitRepoTrustView | null> => {
    if (typeof folderPath !== 'string' || !folderPath.trim()) return null
    return trust.view(folderPath).catch(() => null)
  })

  ipcMain.handle(
    ANSWER_CHANNEL,
    async (
      _,
      input: { folderPath?: unknown; hash?: unknown; decision?: unknown },
    ): Promise<GitRepoTrustView | null> => {
      const { folderPath, hash, decision } = input ?? {}
      if (typeof folderPath !== 'string' || !folderPath.trim() || typeof hash !== 'string' || !hash) return null
      if (decision !== 'trusted' && decision !== 'dismissed') return null
      const view = await trust.answer(folderPath, hash, decision satisfies GitRepoTrustDecision)
      for (const window of getWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANGED_CHANNEL, view)
      }
      return view
    },
  )
}
