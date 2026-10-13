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

/**
 * A creation's end: created by the forge's CLI, already there, a forge page to
 * open, the forge's list to look in, or why not. The window opens the address
 * and says what happened; the sentences about a page or list are its to write,
 * because only it learns whether the page actually opened.
 */
export type CreatePullRequestOutcome =
  | { ok: true; kind: 'created'; url: string }
  /** The branch had one already, whoever opened it; shown, never linked to the chat. */
  | { ok: true; kind: 'existing'; url: string }
  | {
      ok: true
      kind: 'page'
      url: string
      /** How the strip names the forge whose page it is: GitLab by name, a Gitea or Bitbucket by its host. */
      place: string
      /**
       * Why the page opens rather than the request being created here (the
       * forge's CLI is missing, signed out or failed), for the strip to say.
       * Absent on a forge the app has no CLI for, where the page is the way.
       */
      reason?: string
      /**
       * The description was not put in the page's address (the forge's page
       * takes none, or it was too long for an address), so the window keeps
       * it for the person to paste rather than losing what they wrote.
       */
      descriptionLeftOut?: true
    }
  | {
      ok: true
      /**
       * The forge's CLI may well have opened the request, but its address
       * could not be read (the CLI printed none Studio recognises, or did not
       * answer in time). `url` is the repository's list of requests, where
       * the person can find it: opening the "new request" page instead would
       * invite a second one.
       */
      kind: 'list'
      url: string
      place: string
      /** What is not known, for the strip to say. */
      reason: string
    }
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
 * name is read as GitHub Enterprise, since `gh` answers for any host it is
 * signed in to; if it is not, the creation says so. (A self-hosted GitLab or
 * Gitea on a host that names neither reads as GitHub too, as it always has.)
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
 * What the forge calls the thing: GitLab says "merge request", every other
 * forge "pull request". The chat's button, dialog and notes use the forge's
 * own word.
 */
export function pullRequestNoun(forge: PullRequestForge | null): 'merge request' | 'pull request' {
  return forge === 'gitlab' ? 'merge request' : 'pull request'
}

/** The longest new-request page address the app opens; past it a server may refuse the request line. */
const MAX_PAGE_URL_CHARS = 8_000
/**
 * The longest it opens on Windows, where the shell hands an address to the
 * browser through a call that refuses one much past 2,048 characters, so a
 * longer one would open nothing at all. Kept under that with room to spare.
 */
const MAX_WINDOWS_PAGE_URL_CHARS = 2_000

/** The longest page address that opens on `platform` (`process.platform`'s values). */
export function maxPageUrlChars(platform: string): number {
  return platform === 'win32' ? MAX_WINDOWS_PAGE_URL_CHARS : MAX_PAGE_URL_CHARS
}

/**
 * The forge's new-request page with the confirmed title and description in
 * its address, where the forge reads them: GitLab's `merge_request[title]`
 * and `merge_request[description]`, Gitea's `title` and `body` on the compare
 * page (Forgejo and Codeberg ignore them and fill the title from the commit).
 * `descriptionFilled` is false when the description is not in the address,
 * because the forge has no field for it or it would make the address too
 * long for `platform` (`maxPageUrlChars`), so the window can keep it for the
 * person to paste.
 */
export function prefilledPullRequestPage(
  remote: ForgeRemote,
  base: string,
  head: string,
  text: { title: string; body: string },
  platform: string,
): { url: string; descriptionFilled: boolean } | null {
  const page = newPullRequestPageUrl(remote, base, head)
  if (!page) return null
  const q = encodeURIComponent
  const fields =
    remote.forge === 'gitlab'
      ? { title: 'merge_request%5Btitle%5D', body: 'merge_request%5Bdescription%5D', join: '&' }
      : remote.forge === 'gitea'
        ? { title: 'title', body: 'body', join: '?' }
        : null
  if (!fields) return { url: page, descriptionFilled: !text.body.trim() }
  const titled = text.title ? `${page}${fields.join}${fields.title}=${q(text.title)}` : page
  const sep = titled === page ? fields.join : '&'
  const full = text.body.trim() ? `${titled}${sep}${fields.body}=${q(text.body)}` : titled
  // Forgejo and Codeberg ignore `body`, and a host does not say whether it
  // runs Gitea or Forgejo, so only GitLab's page is trusted to show the
  // description it was handed.
  const max = maxPageUrlChars(platform)
  if (full.length <= max) {
    return { url: full, descriptionFilled: !text.body.trim() || remote.forge === 'gitlab' }
  }
  return { url: titled.length <= max ? titled : page, descriptionFilled: !text.body.trim() }
}

/**
 * The repository's list of open requests on the forge, where one the forge's
 * CLI opened without saying its address can be found. Null for a forge the
 * app drives no CLI on.
 */
export function pullRequestListPageUrl(remote: ForgeRemote): string | null {
  switch (remote.forge) {
    case 'gitlab':
      return `${remote.webUrl}/-/merge_requests`
    case 'gitea':
      return `${remote.webUrl}/pulls`
    default:
      return null
  }
}

/**
 * Where a forge opens a new pull request from `head` into `base`, filled in,
 * for a forge the app does not create on itself (Bitbucket, and GitLab or
 * Gitea when their CLI cannot). Null for GitHub and Azure DevOps.
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
