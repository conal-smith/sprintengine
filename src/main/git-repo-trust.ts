import type { GitRepoTrustDecision, GitRepoTrustView } from '../shared/ipc/git-repo-trust'
import { createRepoProgramsReader, type RepoProgramsRead, type RepoProgramsReader } from './git-repo-programs'
import { installGitRepoTrust, type GitRepoTrustAnswer } from './git-run'
import { createGitRepoTrustStore, type GitRepoTrustStore } from './git-repo-trust-store'

// Whether the person trusts the programs a repository's own config names
// (git-repo-programs.ts), for the banner on its project and for the app's own
// git (git-run.ts, `installGitRepoTrust`). A repository that names none has
// nothing to trust and is never asked about.

export type GitRepoTrust = {
  /** What the banner shows for the repository `folderPath` is in; null outside a repository. */
  view(folderPath: string): Promise<GitRepoTrustView | null>
  /**
   * Records the answer for the settings the banner showed (`hash`). Settings
   * that changed since are not answered for: the view that comes back asks
   * about the new ones.
   */
  answer(folderPath: string, hash: string, decision: GitRepoTrustDecision): Promise<GitRepoTrustView | null>
  /** For the git runner: the repository's program settings and whether they are trusted. */
  answerFor(cwd: string): Promise<GitRepoTrustAnswer | null>
}

export function createGitRepoTrust(deps: { store: GitRepoTrustStore; reader?: RepoProgramsReader }): GitRepoTrust {
  const reader = deps.reader ?? createRepoProgramsReader()

  const viewOf = (read: RepoProgramsRead): GitRepoTrustView => ({
    repoPath: read.repoPath,
    settings: [...new Set(read.settings.map((entry) => entry.key))],
    hash: read.hash,
    decision: read.settings.length > 0 ? deps.store.decisionFor(read.repoPath, read.hash) : null,
  })

  return {
    async view(folderPath) {
      const read = await reader.read(folderPath)
      return read ? viewOf(read) : null
    },
    async answer(folderPath, hash, decision) {
      const read = await reader.read(folderPath)
      if (!read) return null
      if (read.settings.length > 0 && read.hash === hash) await deps.store.record(read.repoPath, hash, decision)
      return viewOf(read)
    },
    async answerFor(cwd) {
      const read = await reader.read(cwd)
      if (!read) return null
      return {
        trusted: read.settings.length === 0 || deps.store.decisionFor(read.repoPath, read.hash) === 'trusted',
        settings: read.settings,
        entries: read.entries,
      }
    },
  }
}

const installed = new Map<string, GitRepoTrust>()

/**
 * The trust service for this process's data folder, installed for its git
 * runner. Main and the Studio server each call it; when the server runs inside
 * main they share one.
 */
export function installGitRepoTrustFor(dataDir: string, log?: (line: string) => void): GitRepoTrust {
  const trust =
    installed.get(dataDir) ??
    createGitRepoTrust({
      store: createGitRepoTrustStore({ resolveUserDataDir: () => dataDir, ...(log ? { log } : {}) }),
    })
  installed.set(dataDir, trust)
  installGitRepoTrust((cwd) => trust.answerFor(cwd))
  return trust
}
