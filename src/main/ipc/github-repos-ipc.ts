import type { IpcMain } from 'electron'
import type { GitHubTokenStore } from '../github-token-store'
import type { RepositoryCloneInput } from '../../shared/electron-api'
import { listGitHubRepos } from '../github-repos'
import { cloneRepository } from '../git-clone'
import { sharedGhRunner } from '../github/gh'
import { createGhHostTokenResolver, type GhHostTokenResolver } from '../github/host-token'

// The clone picker's calls. No token ever crosses IPC: the handlers resolve
// it on this side — the saved one for github.com, `gh`'s sign-in for a
// company's own GitHub — and the renderer only ever sees repo metadata, clone
// progress and outcomes.
export function registerGitHubReposIpc(ipcMain: IpcMain, githubTokenStore: GitHubTokenStore): void {
  ipcMain.handle('github:list-repos', () => listGitHubRepos(githubTokenStore))

  // Made on the first clone that needs it, not at registration: most windows
  // never clone, and the resolver holds a cache for the life of the process.
  let hostTokens: GhHostTokenResolver | null = null
  const running = new Map<string, AbortController>()

  ipcMain.handle('github:clone', async (event, input: unknown) => {
    const request = input as Partial<RepositoryCloneInput> | null
    if (
      !request ||
      typeof request.url !== 'string' ||
      typeof request.parentDir !== 'string' ||
      typeof request.folderName !== 'string' ||
      (request.branch != null && typeof request.branch !== 'string') ||
      (request.cloneId !== undefined && typeof request.cloneId !== 'string')
    ) {
      return { ok: false as const, reason: 'invalid' as const, message: 'Invalid clone request.' }
    }
    const cloneId = request.cloneId
    const controller = new AbortController()
    if (cloneId) running.set(cloneId, controller)
    try {
      return await cloneRepository(
        {
          url: request.url,
          parentDir: request.parentDir,
          folderName: request.folderName,
          branch: request.branch ?? null,
        },
        {
          token: await githubTokenStore.resolveToken(),
          resolveHostToken: (host) => (hostTokens ??= createGhHostTokenResolver(sharedGhRunner()))(host),
          signal: controller.signal,
          onProgress: cloneId
            ? (progress) => {
                if (!event.sender.isDestroyed()) event.sender.send('github:clone-progress', { cloneId, ...progress })
              }
            : undefined,
        },
      )
    } finally {
      if (cloneId && running.get(cloneId) === controller) running.delete(cloneId)
    }
  })

  ipcMain.handle('github:clone-cancel', (_, cloneId: unknown) => {
    if (typeof cloneId === 'string') running.get(cloneId)?.abort()
  })
}
