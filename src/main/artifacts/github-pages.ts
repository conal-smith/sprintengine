import { normalizeSiteUrl, type ArtifactsRepository } from '../../shared/artifacts'

// GitHub Pages, through `gh api` on the repository's own host (github.com or
// a GitHub Enterprise Server), the way the app reads GitHub everywhere: gh's
// sign-in for that host is the only credential.
//
// The site's address is never worked out here: it is `html_url` as GitHub
// answers it, so a custom domain or an Enterprise Server's own Pages host is
// simply what the person gets.
//
// Turning Pages on (`POST /repos/{owner}/{repo}/pages`, main at /) needs main
// to exist: the caller publishes the site's first commit before it asks.
// Two callers asking at once (a settings test and a first publish) share one
// request, and a 409 — another machine turned it on in between — is read as
// "it is on", so Pages is never asked to turn on twice.

export type GhApiRequest = { method?: 'GET' | 'POST'; fields?: Record<string, string> }

export type GhApiAnswer =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number | null; message: string; notInstalled?: boolean }

/** `gh api` against a host. */
export type GhApi = (host: string, path: string, request?: GhApiRequest) => Promise<GhApiAnswer>

export type PagesSite = {
  /** `html_url`, ending in a slash. */
  url: string
  /** `built`, `building`, `errored`, or null before the first build. */
  status: string | null
  branch: string | null
  path: string | null
}

export type PagesState = { state: 'on'; site: PagesSite } | { state: 'off' } | { state: 'error'; message: string }

function apiHost(repository: ArtifactsRepository): string {
  return repository.host.replace(/:\d+$/, '')
}

function repoPath(repository: ArtifactsRepository): string {
  return `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
}

function label(repository: ArtifactsRepository): string {
  return `${repository.owner}/${repository.name}`
}

/** What a refused Pages request means, and what the person does about it. */
export function describePagesFailure(
  repository: ArtifactsRepository,
  answer: Extract<GhApiAnswer, { ok: false }>,
): string {
  const host = apiHost(repository)
  const text = answer.message
  if (answer.notInstalled) {
    return `Studio turns on GitHub Pages through the GitHub CLI, which is not installed. Install gh, then sign in with \`gh auth login --hostname ${host}\`.`
  }
  if (/plan does not support|upgrade your plan|not available for private|private repositor(y|ies).*plan/i.test(text)) {
    return (
      `GitHub Pages is not available for a private repository on the plan ${repository.owner} is on. ` +
      `Make ${label(repository)} public (its Pages site would be public anyway), move to a plan that allows it, or choose Cloudflare Pages.`
    )
  }
  if (answer.status === 401 || /bad credentials|requires authentication|not logged in|gh auth login/i.test(text)) {
    return `This machine is not signed in to ${host}. Run \`gh auth login --hostname ${host}\`, then try again.`
  }
  if (answer.status === 403 || /resource not accessible|must have admin|admin rights|scope|permission/i.test(text)) {
    return (
      `The sign-in gh uses for ${host} may not change ${label(repository)}'s settings: turning on Pages needs admin rights on the repository. ` +
      `With a classic token, run \`gh auth refresh --hostname ${host} --scopes repo\`; with a fine-grained token, give it Pages (write) and Administration (read) on this repository.`
    )
  }
  if (answer.status === 404) {
    return `${host} has no repository ${label(repository)} that this machine's sign-in can see. Check the address, or sign in with an account that can: \`gh auth login --hostname ${host}\`.`
  }
  return `GitHub answered${answer.status ? ` HTTP ${answer.status}` : ''} about Pages for ${label(repository)}: ${text || 'no reason given'}.`
}

function siteOf(json: unknown): PagesSite | null {
  if (!json || typeof json !== 'object') return null
  const raw = json as { html_url?: unknown; status?: unknown; source?: { branch?: unknown; path?: unknown } | null }
  const url = typeof raw.html_url === 'string' ? normalizeSiteUrl(raw.html_url) : null
  if (!url) return null
  return {
    url,
    status: typeof raw.status === 'string' ? raw.status : null,
    branch: typeof raw.source?.branch === 'string' ? raw.source.branch : null,
    path: typeof raw.source?.path === 'string' ? raw.source.path : null,
  }
}

/** Whether Pages is on for the repository, and where it serves. */
export async function readPages(gh: GhApi, repository: ArtifactsRepository): Promise<PagesState> {
  const answer = await gh(apiHost(repository), `${repoPath(repository)}/pages`)
  if (answer.ok) {
    const site = siteOf(answer.json)
    return site
      ? { state: 'on', site }
      : { state: 'error', message: 'GitHub answered about Pages without a site address.' }
  }
  if (answer.status === 404 && !answer.notInstalled) return { state: 'off' }
  return { state: 'error', message: describePagesFailure(repository, answer) }
}

const enabling = new Map<
  string,
  Promise<{ ok: true; site: PagesSite; turnedOn: boolean } | { ok: false; message: string }>
>()

/**
 * Pages on, serving main at /: read first, turned on only when off. The
 * repository's main must exist. One request per repository at a time.
 */
export function ensurePages(
  gh: GhApi,
  repository: ArtifactsRepository,
): Promise<{ ok: true; site: PagesSite; turnedOn: boolean } | { ok: false; message: string }> {
  const key = `${apiHost(repository).toLowerCase()}/${label(repository).toLowerCase()}`
  const running = enabling.get(key)
  if (running) return running
  const work = (async () => {
    const before = await readPages(gh, repository)
    if (before.state === 'on') return { ok: true as const, site: before.site, turnedOn: false }
    if (before.state === 'error') return { ok: false as const, message: before.message }
    const answer = await gh(apiHost(repository), `${repoPath(repository)}/pages`, {
      method: 'POST',
      fields: { 'source[branch]': 'main', 'source[path]': '/' },
    })
    if (answer.ok) {
      const site = siteOf(answer.json)
      if (site) return { ok: true as const, site, turnedOn: true }
    } else if (answer.status !== 409) {
      return { ok: false as const, message: describePagesFailure(repository, answer) }
    }
    // On already (another machine, a moment ago), or answered without its address.
    const after = await readPages(gh, repository)
    if (after.state === 'on') return { ok: true as const, site: after.site, turnedOn: answer.ok }
    return {
      ok: false as const,
      message: after.state === 'error' ? after.message : 'GitHub did not turn Pages on. Try again in a moment.',
    }
  })().finally(() => enabling.delete(key))
  enabling.set(key, work)
  return work
}

/**
 * Wait for Pages' latest build to finish, the first one especially: a new
 * site answers 404 for a minute or two. `built` or `errored` as GitHub says,
 * `timeout` when it has not finished in time.
 */
export async function waitForPagesBuild(
  gh: GhApi,
  repository: ArtifactsRepository,
  options: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<'built' | 'errored' | 'timeout'> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + options.timeoutMs
  for (;;) {
    const answer = await gh(apiHost(repository), `${repoPath(repository)}/pages/builds/latest`)
    const status =
      answer.ok && answer.json && typeof answer.json === 'object' ? (answer.json as { status?: unknown }).status : null
    if (status === 'built') return 'built'
    if (status === 'errored') return 'errored'
    if (now() + (options.intervalMs ?? 5000) > deadline) return 'timeout'
    await sleep(options.intervalMs ?? 5000)
  }
}
