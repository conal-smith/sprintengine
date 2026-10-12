/**
 * Validation and normalization for a clone source, shared by the main process
 * (which refuses to spawn git on anything else) and the renderer's Import from
 * Git step (which previews the source, derives the folder leaf and shows
 * inline errors).
 *
 * What a person pastes is rarely a bare clone URL. It is the address bar of a
 * repository page (with `/tree/main`, `/-/blob/…`, `?version=GB…` on the end),
 * the "Clone" box of a host that puts the account in the URL
 * (`https://acme@dev.azure.com/…`), a whole `git clone …` line copied from a
 * README, or just `owner/repo`. Each of those is turned into the URL git
 * should fetch, and a branch the page was showing rides along so the clone
 * can check it out.
 *
 * Only real transports pass: https, http (self-hosted servers on a private
 * network often have nothing else), git://, ssh://, or scp-style
 * user@host:path. A leading dash, an exotic transport (ext::, file://), or
 * embedded whitespace is rejected outright — this string reaches a git argv.
 */

/** Which kind of server a URL points at, for the preview's mark and the sign-in hint. */
export type GitHostProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'gitea' | 'sourcehut' | 'git'

export type CloneUrlValidation =
  | {
      ok: true
      /** What git is handed: normalized, without page sub-paths, query or fragment. */
      url: string
      /** The host when git will speak https to it — the only case a stored token may ride. */
      httpsHost: string | null
      /** The server's host name, lower-cased, whatever the transport. */
      host: string
      provider: GitHostProvider
      /** The repository's path on its host, `.git` dropped — `group/sub/repo`. */
      path: string
      /** The folder leaf the clone defaults to. */
      repoName: string
      /** A branch the pasted page or command named, or null for the remote's default. */
      branch: string | null
      /** Plain http or git:// — nothing on the wire is encrypted. */
      insecure: boolean
    }
  | { ok: false; error: string }

const SCP_LIKE =
  /^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9_.~-][A-Za-z0-9_./~-]*?)(\.git)?\/?$/

// `owner/repo` with nothing else: GitHub's own shorthand, the one most READMEs
// and chats use.
const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/

// A host typed without a scheme: `gitlab.com/group/repo`, `git.acme.dev/x/y`.
const SCHEMELESS_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?\/\S+$/

// What git accepts as a branch name, minus the forms that could read as an
// option or walk out of refs/heads. Checked again in main before it reaches argv.
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+-]+(?<![./])$/

export function isValidBranchName(raw: string): boolean {
  const branch = raw.trim()
  return branch.length > 0 && branch.length <= 255 && BRANCH_NAME.test(branch) && !branch.endsWith('.lock')
}

/**
 * The provider a host name belongs to: public hosts by name, self-hosted ones
 * by a label that names the product anywhere in the host (`gitlab.acme.dev`,
 * `git.github.acme.com`) — the way companies name the servers they run.
 */
export function providerForHost(rawHost: string): GitHostProvider {
  const host = rawHost.toLowerCase()
  const labels = host.split('.')
  if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com') || host.endsWith('.visualstudio.com')) return 'azure'
  if (host === 'github.com' || host.endsWith('.ghe.com') || labels.includes('github')) return 'github'
  if (labels.includes('gitlab')) return 'gitlab'
  if (labels.includes('bitbucket')) return 'bitbucket'
  if (host === 'codeberg.org' || labels.includes('gitea') || labels.includes('forgejo')) return 'gitea'
  if (host === 'git.sr.ht') return 'sourcehut'
  return 'git'
}

/** The provider's name as a person reads it. */
export function providerLabel(provider: GitHostProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'bitbucket':
      return 'Bitbucket'
    case 'azure':
      return 'Azure DevOps'
    case 'gitea':
      return 'Gitea'
    case 'sourcehut':
      return 'SourceHut'
    case 'git':
      return 'Git'
  }
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
}

function repoNameFromPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return stripGitSuffix(segments[segments.length - 1] ?? '')
}

/**
 * `git clone [opts] <url> [dir]` copied whole: the URL, and the branch its
 * `-b`/`--branch` names. Anything else is not a clone line and comes back as is.
 */
function unwrapCloneCommand(input: string): { source: string; branch: string | null } {
  const words = input.split(/\s+/)
  if (words[0] === '$') words.shift()
  if (words[0] !== 'git' || words[1] !== 'clone') return { source: input, branch: null }
  let branch: string | null = null
  for (let i = 2; i < words.length; i += 1) {
    const word = words[i]
    if (word === '-b' || word === '--branch') {
      branch = words[i + 1] ?? null
      i += 1
    } else if (word.startsWith('--branch=')) {
      branch = word.slice('--branch='.length)
    } else if (word === '--depth' || word === '--origin' || word === '-o' || word === '--config' || word === '-c') {
      i += 1
    } else if (!word.startsWith('-')) {
      return { source: word, branch }
    }
  }
  return { source: '', branch }
}

/**
 * A repository page's address, cut back to the repository: the segments that
 * are the repository, and the branch the page was on when it names one.
 */
function repositoryPath(
  provider: GitHostProvider,
  segments: string[],
  query: URLSearchParams,
): { segments: string[]; branch: string | null } | null {
  // The segments arrive decoded once already; decoding a branch again would
  // turn a literal `%` into a URIError.
  switch (provider) {
    case 'github': {
      if (segments.length < 2) return null
      // /tree/<branch> names it; /blob/<branch>/file and /commits/<branch> do
      // too, but a branch with a slash cannot be told from the path after it,
      // so only the next segment is taken — the field shows it to correct.
      const kind = segments[2]
      const branch = kind === 'tree' || kind === 'blob' || kind === 'commits' ? (segments[3] ?? null) : null
      return { segments: segments.slice(0, 2), branch }
    }
    case 'gitlab': {
      // Groups nest, so the repository is everything before GitLab's `/-/`
      // separator; `/-/tree/<branch>` after it names the branch.
      const dash = segments.indexOf('-')
      if (dash === -1) return segments.length >= 2 ? { segments, branch: null } : null
      if (dash < 2) return null
      const branch =
        segments[dash + 1] === 'tree' || segments[dash + 1] === 'blob' ? (segments[dash + 2] ?? null) : null
      return { segments: segments.slice(0, dash), branch }
    }
    case 'bitbucket': {
      if (segments.length < 2) return null
      // Bitbucket Server: /projects/KEY/repos/name/browse and /scm/key/name.git.
      if (segments[0] === 'projects' && segments[2] === 'repos' && segments[3]) {
        const at = query.get('at')
        return {
          segments: ['scm', segments[1].toLowerCase(), segments[3]],
          branch: at ? at.replace(/^refs\/heads\//, '') : null,
        }
      }
      if (segments[0] === 'scm') return segments.length >= 3 ? { segments: segments.slice(0, 3), branch: null } : null
      const kind = segments[2]
      const branch = kind === 'src' || kind === 'branch' ? (segments[3] ?? null) : null
      return { segments: segments.slice(0, 2), branch }
    }
    case 'azure': {
      // …/{project}/_git/{repo}, with the organization (dev.azure.com) or a
      // collection (an on-premises server) in front. The branch rides
      // ?version=GB<branch>.
      const git = segments.indexOf('_git')
      if (git === -1 || !segments[git + 1]) return segments.length >= 2 ? { segments, branch: null } : null
      const version = query.get('version')
      return {
        segments: segments.slice(0, git + 2),
        branch: version?.startsWith('GB') ? version.slice(2) || null : null,
      }
    }
    case 'gitea': {
      if (segments.length < 2) return null
      // /src/branch/<branch> on Gitea and Forgejo.
      const branch = segments[2] === 'src' && segments[3] === 'branch' ? (segments[4] ?? null) : null
      return { segments: segments.slice(0, 2), branch }
    }
    case 'sourcehut': {
      if (segments.length < 2) return null
      const branch = segments[2] === 'tree' ? (segments[3] ?? null) : null
      return { segments: segments.slice(0, 2), branch }
    }
    case 'git':
      // An unknown server's page layout is unknown: the path is the repository.
      return segments.length >= 1 ? { segments, branch: null } : null
  }
}

const INVALID = 'That does not look like a repository URL.'

export function validateCloneUrl(raw: string): CloneUrlValidation {
  const pasted = raw.trim()
  if (!pasted) return { ok: false, error: 'Enter a repository URL.' }
  const unwrapped = unwrapCloneCommand(pasted)
  let trimmed = unwrapped.source.replace(/^<|>$/g, '')
  if (!trimmed) return { ok: false, error: INVALID }
  if (trimmed.startsWith('-') || /\s/.test(trimmed)) return { ok: false, error: INVALID }
  const commandBranch = unwrapped.branch && isValidBranchName(unwrapped.branch) ? unwrapped.branch : null

  if (OWNER_REPO.test(trimmed) && !trimmed.includes('..')) trimmed = `https://github.com/${trimmed}`
  else if (SCHEMELESS_HOST.test(trimmed) && !trimmed.includes('@')) trimmed = `https://${trimmed}`

  const web = trimmed.match(/^(https?|git):\/\//i)
  if (web) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: INVALID }
    }
    if (parsed.password) {
      return {
        ok: false,
        error: 'Remove the password from the URL — sign in with a saved token, a credential helper, or ssh.',
      }
    }
    const scheme = web[1].toLowerCase()
    const host = parsed.hostname.toLowerCase()
    if (!host) return { ok: false, error: INVALID }
    const provider = providerForHost(host)
    let segments: string[]
    try {
      segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return { ok: false, error: INVALID }
    }
    const repo = repositoryPath(provider, segments, parsed.searchParams)
    if (!repo || !repo.segments.length) return { ok: false, error: 'The URL is missing a repository path.' }
    if (repo.segments.some((segment) => segment === '.' || segment === '..' || /[\s\\]/.test(segment))) {
      return { ok: false, error: INVALID }
    }
    const pathname = `/${repo.segments.map(encodeURIComponent).join('/')}`
    const repoName = repoNameFromPath(repo.segments.join('/'))
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    // A user name stays: Azure DevOps and Bitbucket put the account there so
    // the credential helper knows whose sign-in to answer with.
    const user = parsed.username ? `${parsed.username}@` : ''
    const port = parsed.port ? `:${parsed.port}` : ''
    const branch = commandBranch ?? (repo.branch && isValidBranchName(repo.branch) ? repo.branch : null)
    return {
      ok: true,
      url: `${scheme}://${user}${host}${port}${pathname}`,
      httpsHost: scheme === 'https' ? host : null,
      host,
      provider,
      path: stripGitSuffix(repo.segments.join('/')),
      repoName,
      branch,
      insecure: scheme !== 'https',
    }
  }

  if (/^ssh:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, error: INVALID }
    }
    const repoName = repoNameFromPath(parsed.pathname)
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    const host = parsed.hostname.toLowerCase()
    return {
      ok: true,
      url: trimmed,
      httpsHost: null,
      host,
      provider: providerForHost(host),
      path: stripGitSuffix(parsed.pathname.replace(/^\/+/, '').replace(/^~/, '')),
      repoName,
      branch: commandBranch,
      insecure: false,
    }
  }

  const scp = trimmed.match(SCP_LIKE)
  if (scp) {
    const repoName = repoNameFromPath(scp[3])
    if (!repoName) return { ok: false, error: 'The URL is missing a repository path.' }
    const host = scp[2].toLowerCase()
    const provider = providerForHost(host)
    // Azure's ssh form carries a `v3/` protocol prefix that is not part of the repository's name.
    const path = stripGitSuffix(scp[3]).replace(provider === 'azure' ? /^v3\// : /^$/, '')
    return {
      ok: true,
      url: trimmed,
      httpsHost: null,
      host,
      provider,
      path,
      repoName,
      branch: commandBranch,
      insecure: false,
    }
  }

  return {
    ok: false,
    error: 'Enter a clone URL (https://… or git@host:owner/repo) or a GitHub owner/repo.',
  }
}
