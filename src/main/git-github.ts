import { runGit } from './git-utils'
import { githubRepositoryOf } from './workspace-git-info'

export type GitHubRepoRef = {
  owner: string
  repo: string
  webUrl: string
}

export async function getGitHubRepoWebUrl(repoRoot: string): Promise<string | null> {
  const repo = await getGitHubRepoRef(repoRoot)
  return repo?.webUrl ?? null
}

async function getGitHubRepoRef(repoRoot: string): Promise<GitHubRepoRef | null> {
  try {
    const originUrl = await runGit(repoRoot, ['remote', 'get-url', 'origin'])
    const repo = githubRepoFromRemote(originUrl)
    if (repo) return repo
  } catch {
    // Ignore missing origin; fall through to scanning all remotes.
  }

  try {
    const remotes = await runGit(repoRoot, ['remote', '-v'])
    for (const line of remotes.split(/\r?\n/)) {
      const [, remoteUrl = ''] = line.trim().split(/\s+/)
      const repo = githubRepoFromRemote(remoteUrl)
      if (repo) return repo
    }
  } catch {
    return null
  }

  return null
}

/**
 * The GitHub repository a remote URL names, by the same reading the workspace
 * view uses (`githubRepositoryOf`): any SSH user (`org-123@github.com:` for
 * certificate auth, not only `git@`), credentials in an https URL, `http`,
 * `git+ssh` and a trailing slash all count.
 */
export function githubRepoFromRemote(remoteUrl: string): GitHubRepoRef | null {
  const slug = githubRepositoryOf(remoteUrl)
  if (!slug) return null
  const [owner = '', repo = ''] = slug.split('/')
  return buildGitHubRepoRef(owner, repo)
}

function buildGitHubRepoRef(owner: string, repo: string): GitHubRepoRef {
  const cleanRepo = repo.replace(/\.git$/u, '')
  return {
    owner,
    repo: cleanRepo,
    webUrl: `https://github.com/${owner}/${cleanRepo}`,
  }
}
