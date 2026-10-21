import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ModuleWorkspaceGitInfoResult, ModuleWorkspaceGitRemote } from '../shared/modules/workspace-view'
import { isMachinePath } from '../shared/machine-paths'
import { parseRemoteFetchUrls, stripRemoteCredentials } from '../shared/repository-identity'
import { getGitRepoRoot } from './git'
import { runGit } from './git-utils'

// A workspace's branch and remotes, for capability modules
// (`MainHost.getWorkspaceGitInfo` / `RendererHost.getWorkspaceGitInfo`).
//
// Git is asked from the workspace's own folder, so it does the resolving every
// module used to re-implement: a worktree's `.git` file → its gitdir → the
// common dir's config, a submodule's own repository rather than its parent's.
// What git cannot know is that `git@github-work:acme/app.git` is GitHub: the
// host is an alias the person's ~/.ssh/config maps to github.com, so an SSH
// remote's host is looked up there before it is classified.

export type WorkspaceGitInfoReaders = {
  readRepoRoot: (folderPath: string) => Promise<string | null>
  readBranch: (repoRoot: string) => Promise<string | null>
  readRemotes: (repoRoot: string) => Promise<string>
  readSshConfig: () => Promise<string>
}

const defaultReaders: WorkspaceGitInfoReaders = {
  readRepoRoot: (folderPath) => getGitRepoRoot(folderPath),
  // `symbolic-ref` answers for a branch with no commits yet, and fails on a
  // detached HEAD, which is the null the contract promises for it.
  readBranch: async (repoRoot) => {
    try {
      const branch = (await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
      return branch || null
    } catch {
      return null
    }
  },
  readRemotes: (repoRoot) => runGit(repoRoot, ['remote', '-v']),
  readSshConfig: async () => {
    try {
      return await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
    } catch {
      return ''
    }
  },
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com'])

/** Never throws: every outcome is a result. */
export async function readFolderGitInfo(
  folderPath: string | null,
  readers: Partial<WorkspaceGitInfoReaders> = {},
): Promise<ModuleWorkspaceGitInfoResult> {
  const read = { ...defaultReaders, ...readers }
  if (!folderPath) return { ok: false, code: 'no_folder', message: 'The workspace has no folder.' }
  if (isMachinePath(folderPath)) {
    return { ok: false, code: 'unavailable', message: "The workspace's folder is on another machine." }
  }
  try {
    const repoRoot = await read.readRepoRoot(folderPath)
    if (!repoRoot) {
      return { ok: false, code: 'not_a_repository', message: "The workspace's folder is not in a git repository." }
    }
    const [branch, remoteText, sshConfig] = await Promise.all([
      read.readBranch(repoRoot),
      read.readRemotes(repoRoot),
      read.readSshConfig(),
    ])
    const remotes: ModuleWorkspaceGitRemote[] = [...parseRemoteFetchUrls(remoteText)]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, url]) => {
        const github = githubRepositoryOf(url, (alias) => resolveSshHostName(alias, sshConfig))
        return { name, url: stripRemoteCredentials(url), ...(github ? { github } : {}) }
      })
    return { ok: true, branch, remotes }
  } catch (error) {
    return {
      ok: false,
      code: 'git_failed',
      message: `git could not read the workspace: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
    }
  }
}

/**
 * `owner/repo` when a remote URL names a GitHub repository, or null. SSH
 * remotes (`git@host:o/r`, `ssh://git@host/o/r`) have their host resolved
 * through `resolveSshHost` first, so an alias for github.com counts.
 */
export function githubRepositoryOf(
  remoteUrl: string,
  resolveSshHost: (alias: string) => string | null = () => null,
): string | null {
  const trimmed = remoteUrl.trim()
  let host: string
  let path: string
  let ssh: boolean
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (scheme) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    const protocol = url.protocol.slice(0, -1).toLowerCase()
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(protocol)) return null
    host = url.hostname
    path = decodeURIComponent(url.pathname)
    ssh = protocol.includes('ssh')
  } else {
    // scp-like: `[user@]host:path`. A Windows drive (`C:\…`) is a local path.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed)
    if (!scp || /^[a-z]$/i.test(scp[1] ?? '')) return null
    host = scp[1] ?? ''
    path = scp[2] ?? ''
    ssh = true
  }
  let hostName = host.toLowerCase()
  if (ssh && !GITHUB_HOSTS.has(hostName)) hostName = (resolveSshHost(host) ?? hostName).toLowerCase()
  if (!GITHUB_HOSTS.has(hostName)) return null
  const segments = path
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  if (segments.length !== 2) return null
  const [owner, repo] = segments as [string, string]
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null
  return `${owner}/${repo}`
}

/**
 * The `HostName` ~/.ssh/config gives an alias, or null. ssh takes the first
 * value it obtains, so the first `Host` block whose patterns match (with `*`,
 * `?` and `!` negation) and sets `HostName` wins; `%h` is the alias itself.
 * `Match` blocks and `Include` are not followed — an alias defined only
 * through them is not recognised.
 */
export function resolveSshHostName(alias: string, config: string): string | null {
  let matching = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line)
    if (!match) continue
    const keyword = (match[1] ?? '').toLowerCase()
    const value = (match[2] ?? '').trim()
    if (keyword === 'host') {
      const patterns = splitSshConfigWords(value)
      matching = patterns !== null && hostPatternsMatch(patterns, alias)
      continue
    }
    if (keyword === 'match') {
      matching = false
      continue
    }
    if (matching && keyword === 'hostname') {
      const hostName = splitSshConfigWords(value)?.[0]
      if (hostName) return hostName.replace(/%h/g, alias)
    }
  }
  return null
}

/**
 * A config value split into words the way ssh splits it: whitespace
 * separates, double or single quotes group, a backslash escapes a quote, a
 * backslash or a space, and a `#` that begins a word starts a comment — so
 * `HostName github.com # work` is `github.com` and `Host "github-work"`
 * matches `github-work`. Null for an unterminated quote, a line ssh refuses.
 */
function splitSshConfigWords(value: string): string[] | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: string | null = null
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string
    const next = value[index + 1] ?? ''
    if (quote) {
      if (char === '\\' && (next === quote || next === '\\')) {
        word += next
        index++
      } else if (char === quote) {
        quote = null
      } else {
        word += char
      }
      continue
    }
    if (char === ' ' || char === '\t') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    if (char === '#' && !inWord) break
    inWord = true
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '\\' && (next === '\\' || next === '"' || next === "'" || next === ' ')) {
      word += next
      index++
    } else {
      word += char
    }
  }
  if (quote) return null
  if (inWord) words.push(word)
  return words
}

function hostPatternsMatch(patterns: string[], alias: string): boolean {
  let matched = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    const regex = new RegExp(
      `^${body
        .split('')
        .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('')}$`,
      'i',
    )
    if (!regex.test(alias)) continue
    if (negated) return false
    matched = true
  }
  return matched
}
