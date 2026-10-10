// Opening a pull request from the chat (owner ruling 2026-10-04): when the
// "Create PR" button may show, which forge a checkout's remote is on, and the
// page a forge opens a new pull request on. Pure and node-free, so the rules
// are testable without git, `gh` or a window.

import type { PullRequestForge } from './pr-url'

/**
 * What the checkout says, read by the main process (`pull-request-create.ts`).
 * Null where git could not answer; a fact that is not known is never guessed.
 */
export type CreatePullRequestFacts = {
  /** The branch checked out; null on a detached HEAD. */
  branch: string | null
  /** The repository's default branch (`origin/HEAD`); null when the clone never recorded one. */
  defaultBranch: string | null
  /**
   * Commits on the branch that are on neither `origin/<default>` nor the head
   * of a pull request from it that merged. Null when git could not count them.
   */
  unmergedCommits: number | null
  /** Whether a pull request from the branch is OPEN; null when the host could not be asked (or is not GitHub). */
  openPullRequest: boolean | null
  /** The forge the checkout's remote is on; null when there is no remote it can name. */
  forge: PullRequestForge | null
}

/** Why the button is not drawn, for the tests and the diagnostics line; `ready` draws it. */
export type CreatePullRequestReadiness =
  | { ready: true }
  | {
      ready: false
      reason:
        'detached' | 'default-branch' | 'nothing-to-propose' | 'open-pull-request' | 'no-remote' | 'unsupported-forge'
    }

/**
 * Whether "Create PR" may show. All of these must hold:
 *
 * - the checkout is on a named branch that is not the repository's default;
 * - the branch has commits the default branch does not, and no merged pull
 *   request already carried them;
 * - no pull request from the branch is open, whoever opened it (a branch
 *   lookup answers whether one EXISTS; it never decides whose it is);
 * - the remote is on a forge a pull request can be opened on from here.
 *
 * An open-pull-request check that could not be made does not hide the button:
 * `gh` missing or signed out is the reason a creation would fail, and the
 * person hears it when they press it rather than never seeing the button.
 *
 * Uncommitted work does not hide it. The 2026-10-04 ruling said work in
 * progress is not proposed, and it still never is: the push sends one commit
 * to `refs/heads/<branch>` and the draft reads only the branch's commits, so
 * nothing in the working tree can reach the pull request. What that ruling no
 * longer does is block the button, since one stray untracked file (a log, a
 * scratch note) hid it on a branch whose commits were ready. The confirm step
 * says how many changes stay behind instead (`uncommittedChanges`).
 */
export function createPullRequestReadiness(facts: CreatePullRequestFacts): CreatePullRequestReadiness {
  if (!facts.branch) return { ready: false, reason: 'detached' }
  if (!facts.defaultBranch || facts.branch === facts.defaultBranch) return { ready: false, reason: 'default-branch' }
  if (!facts.unmergedCommits || facts.unmergedCommits <= 0) return { ready: false, reason: 'nothing-to-propose' }
  if (facts.openPullRequest === true) return { ready: false, reason: 'open-pull-request' }
  if (!facts.forge) return { ready: false, reason: 'no-remote' }
  if (facts.forge === 'azure-devops') return { ready: false, reason: 'unsupported-forge' }
  return { ready: true }
}

/** What the strip needs to decide on the button. Null fields are facts git could not give. */
export type CreatePullRequestState = {
  readiness: CreatePullRequestReadiness
  gitRoot: string | null
  branch: string | null
  /** The commit the branch is at, which a confirmed Create PR pushes and proposes. */
  headSha: string | null
  /**
   * Paths with uncommitted changes (tracked, staged or not, and untracked
   * files git does not ignore), which the pull request will not include; null
   * when git could not say.
   */
  uncommittedChanges: number | null
  base: string | null
  forge: PullRequestForge | null
}

/**
 * The branch and commit a person confirmed a pull request for. The push and
 * the creation are refused when the checkout has moved off it since, rather
 * than proposing a branch or commits they did not see.
 */
export type PullRequestCheckoutPin = { branch: string; headSha: string }

/** A creation's end: created by `gh`, already there, a forge page to open, or why not. */
export type CreatePullRequestOutcome =
  /** `existing`: the branch had one already, whoever opened it; shown, never linked to the chat. */
  | { ok: true; kind: 'created' | 'existing'; url: string }
  | { ok: true; kind: 'page'; url: string }
  | { ok: false; message: string }

export type PushForPullRequestOutcome = { ok: true; pushed: boolean } | { ok: false; message: string }

/** A remote, read: the forge it is on and the repository's web address. */
export type ForgeRemote = { forge: PullRequestForge; webUrl: string }

/**
 * The forge a remote URL is on, and the repository's web URL. A remote URL has
 * no pull request path to read a shape from, so the HOST says which forge:
 * github.com and any host with a `github` label (GitHub Enterprise); gitlab.com
 * and any `gitlab` label; codeberg.org and any `gitea` or `forgejo` label;
 * bitbucket.org; dev.azure.com and `*.visualstudio.com`. A host none of these
 * name is read as GitHub Enterprise, since `gh` is the one host CLI the app
 * drives and it answers for any host it is signed in to; if it is not, the
 * creation says so.
 */
export function forgeOfRemote(remoteUrl: string): ForgeRemote | null {
  const location = remoteLocation(remoteUrl)
  if (!location) return null
  const { scheme, host, port, path } = location
  const labels = host.split('.')
  const has = (label: string) => labels.includes(label) || labels.some((part) => part.startsWith(`${label}-`))
  let forge: PullRequestForge = 'github'
  if (host === 'bitbucket.org' || has('bitbucket')) forge = 'bitbucket'
  else if (host === 'gitlab.com' || has('gitlab')) forge = 'gitlab'
  else if (host === 'codeberg.org' || has('gitea') || has('forgejo')) forge = 'gitea'
  else if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || host === 'ssh.dev.azure.com')
    forge = 'azure-devops'
  return { forge, webUrl: `${scheme}://${port ? `${host}:${port}` : host}/${path}` }
}

/**
 * Where a forge opens a new pull request from `head` into `base`, filled in,
 * for the forges the app does not create on itself (v1: every one but
 * GitHub). Null for GitHub and Azure DevOps.
 */
export function newPullRequestPageUrl(remote: ForgeRemote, base: string, head: string): string | null {
  const q = encodeURIComponent
  switch (remote.forge) {
    case 'gitlab':
      return `${remote.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${q(head)}&merge_request%5Btarget_branch%5D=${q(base)}`
    case 'gitea':
      return `${remote.webUrl}/compare/${q(base)}...${q(head)}`
    case 'bitbucket':
      return `${remote.webUrl}/pull-requests/new?source=${q(head)}&dest=${q(base)}`
    default:
      return null
  }
}

/**
 * The web scheme, the host (lower case, no user), the web port, and the
 * repository path (no `.git`) of a remote URL. Only an http(s) remote's scheme
 * and port are the web server's: a forge cloned over plain http (a Gitea on
 * :3000) serves its pages there too, and an SSH remote's port
 * (`ssh://git@host:2222/…`) is the SSH daemon's, where a page would not load.
 */
function remoteLocation(
  remoteUrl: string,
): { scheme: 'http' | 'https'; host: string; port: string; path: string } | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null
  let scheme: 'http' | 'https' = 'https'
  let host = ''
  let port = ''
  let path = ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      host = url.hostname
      if (url.protocol === 'https:' || url.protocol === 'http:') port = url.port
      if (url.protocol === 'http:') scheme = 'http'
      path = url.pathname
    } catch {
      return null
    }
  } else {
    // A Windows path (`C:/remotes/acme/app.git`) is a folder, as git reads
    // it, not host `c`: a drive letter is never a host.
    if (/^[a-z]:[\\/]/i.test(trimmed)) return null
    // scp-style: `git@host:owner/name.git`.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  const clean = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  // Azure's SSH remote is `v3/<org>/<project>/<repo>`; its web path is not
  // derived from it here, and Azure is not offered anyway.
  if (!host || clean.length < 2) return null
  return { scheme, host: host.toLowerCase(), port, path: clean.join('/') }
}
