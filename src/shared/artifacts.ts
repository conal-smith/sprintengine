// Published artifacts: where the `artifacts.*` tools publish an agent's HTML
// mockups so they can be opened from any device. The person picks one host on
// Settings ▸ Artifacts: GitHub Pages (a repository Pages serves, on github.com
// or a GitHub Enterprise Server) or Cloudflare Pages (a project the app uploads
// to directly, optionally keeping the site's source in a git repository too).
// Until one is set up, the tools refuse and name that page.

/** Where the setting lives, as the tools' refusal and the docs name it. */
export const ARTIFACTS_SETTINGS_PAGE = 'Settings ▸ Artifacts'

export const ARTIFACTS_PROVIDERS = ['github-pages', 'cloudflare-pages'] as const
export type ArtifactsProviderKind = (typeof ARTIFACTS_PROVIDERS)[number]

export type GitHubPagesSettings = {
  /** The repository as the person gave it: an https or ssh URL, or `owner/name` on github.com. */
  repositoryUrl: string
  /** The site's address when the person overrode it; empty for the one worked out from the repository. */
  pagesUrl: string
}

export type CloudflarePagesSettings = {
  accountId: string
  projectName: string
  /** A domain the project is also served on, such as `artifacts.example.com`; empty for none. */
  customDomain: string
  /** A git repository to keep the site's source and history in; empty for none. */
  repositoryUrl: string
}

/** What main keeps in plain settings. The Cloudflare token is never here: it is sealed apart. */
export type ArtifactsSettings = {
  provider: ArtifactsProviderKind | null
  github: GitHubPagesSettings
  cloudflare: CloudflarePagesSettings
}

/** The setting as the page shows it. */
export type ArtifactsSettingsView = ArtifactsSettings & {
  /** Whether a Cloudflare token is held, never the token. */
  cloudflareToken: { configured: boolean; encryptionAvailable: boolean }
  /** The address the gallery is served at, for the chosen host, or null while it is not set up. */
  siteUrl: string | null
  /** The Pages address worked out from the GitHub repository, shown as the override's placeholder. */
  derivedPagesUrl: string | null
}

export type ArtifactsSettingsField =
  | 'provider'
  | 'github.repositoryUrl'
  | 'github.pagesUrl'
  | 'cloudflare.accountId'
  | 'cloudflare.projectName'
  | 'cloudflare.customDomain'
  | 'cloudflare.repositoryUrl'
  | 'cloudflare.token'

export type ArtifactsSettingsWriteResult =
  { ok: true; view: ArtifactsSettingsView } | { ok: false; field: ArtifactsSettingsField; message: string }

/**
 * One line of a configuration check: what was checked, how it went, and what
 * it found. `warn` is a check that passed with something to do (Pages not
 * turned on yet): publishing works, the site does not show it yet.
 */
export type ArtifactsCheck = { label: string; status: 'pass' | 'warn' | 'fail'; detail: string }

/** `ok` when no check failed. */
export type ArtifactsTestResult = { ok: boolean; checks: ArtifactsCheck[] }

export const EMPTY_ARTIFACTS_SETTINGS: ArtifactsSettings = {
  provider: null,
  github: { repositoryUrl: '', pagesUrl: '' },
  cloudflare: { accountId: '', projectName: '', customDomain: '', repositoryUrl: '' },
}

/** A git repository the site is kept in, as the app pushes to it. */
export type ArtifactsRepository = {
  /** The host the remote is on (`github.com`, a company's GitHub), or `` for a local path. */
  host: string
  owner: string
  name: string
  /** What git is pointed at. Never carries a credential. */
  remoteUrl: string
  transport: 'https' | 'ssh' | 'file'
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/

function ownerAndName(path: string): { owner: string; name: string } | null {
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2) return null
  const name = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name) || name === '.' || name === '..' || owner === '..')
    return null
  return { owner, name }
}

const SIGN_IN_REFUSED =
  'Leave the sign-in out of the address. Studio uses the credentials this machine already has for the host (gh, or git’s own).'

/** Whether an address carries a user and password (or token) before its host. */
function hasSignIn(input: string): boolean {
  try {
    const url = new URL(input.trim())
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? Boolean(url.username || url.password)
      : Boolean(url.password)
  } catch {
    return false
  }
}

const REPOSITORY_HELP =
  'Enter the repository’s address, such as https://github.com/acme/artifacts, git@github.com:acme/artifacts.git, or acme/artifacts on github.com.'

/**
 * A repository from what the person typed: `owner/name` (on github.com), its
 * https address on any host, its ssh address, or a `file://` path to a bare
 * repository. An address with a password or token in it is refused: it would
 * be kept in plain settings and shown on screen.
 */
export function parseArtifactsRepositoryUrl(
  input: string,
): { ok: true; repository: ArtifactsRepository } | { ok: false; message: string } {
  const text = input.trim()
  if (!text) return { ok: false, message: REPOSITORY_HELP }
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/.test(text)) {
    const parsed = ownerAndName(text)
    if (!parsed) return { ok: false, message: REPOSITORY_HELP }
    return {
      ok: true,
      repository: {
        host: 'github.com',
        ...parsed,
        remoteUrl: `https://github.com/${parsed.owner}/${parsed.name}.git`,
        transport: 'https',
      },
    }
  }
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(text)
  if (scp) {
    const host = scp[2].toLowerCase()
    const parsed = ownerAndName(scp[3])
    if (!parsed || !HOST_PATTERN.test(host)) return { ok: false, message: REPOSITORY_HELP }
    return { ok: true, repository: { host, ...parsed, remoteUrl: text, transport: 'ssh' } }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: REPOSITORY_HELP }
  }
  if (url.protocol === 'file:') {
    const parsed = ownerAndName(decodeURIComponent(url.pathname))
    if (!parsed) return { ok: false, message: REPOSITORY_HELP }
    return { ok: true, repository: { host: '', ...parsed, remoteUrl: url.toString(), transport: 'file' } }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    return { ok: false, message: 'Use the repository’s https or ssh address.' }
  }
  if (url.password || (url.protocol === 'https:' && url.username)) {
    return { ok: false, message: SIGN_IN_REFUSED }
  }
  const host = url.host.toLowerCase()
  const parsed = ownerAndName(decodeURIComponent(url.pathname))
  if (!parsed || !HOST_PATTERN.test(host) || url.search || url.hash) return { ok: false, message: REPOSITORY_HELP }
  const remoteUrl =
    url.protocol === 'https:'
      ? `https://${host}${url.pathname.replace(/\/+$/, '').replace(/(?<!\.git)$/, '.git')}`
      : text
  return {
    ok: true,
    repository: { host, ...parsed, remoteUrl, transport: url.protocol === 'https:' ? 'https' : 'ssh' },
  }
}

/**
 * The address GitHub Pages serves a repository's site at when it builds from a
 * branch. github.com: `https://<owner>.github.io/<repo>/`, or the owner's own
 * site for a repository named `<owner>.github.io`. A GitHub Enterprise Server
 * with subdomain isolation (the recommended set-up) serves
 * `https://pages.<host>/<owner>/<repo>/`; one without it serves
 * `https://<host>/pages/<owner>/<repo>/`, which is what the override is for.
 * Null for a repository that is not on a GitHub host.
 */
export function defaultGitHubPagesUrl(repository: ArtifactsRepository): string | null {
  if (repository.transport === 'file' || !repository.host) return null
  const host = repository.host.replace(/:\d+$/, '')
  if (host === 'github.com') {
    const user = repository.owner.toLowerCase()
    if (repository.name.toLowerCase() === `${user}.github.io`) return `https://${user}.github.io/`
    return `https://${user}.github.io/${repository.name}/`
  }
  return `https://pages.${host}/${repository.owner}/${repository.name}/`
}

/** A site address as stored: http(s), no credentials, query or fragment, ending in a slash. Null when it is not one. */
export function normalizeSiteUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  // http only for a server on this machine: a test site, never a published one.
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || !url.hostname) return null
  if (url.username || url.password) return null
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.toString()
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/
/** Cloudflare's rule for a Pages project name: lowercase letters, digits and hyphens, at most 58. */
const PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/

/** The address a Cloudflare Pages project is served at: its custom domain, or `<project>.pages.dev`. */
export function cloudflareSiteUrl(settings: CloudflarePagesSettings): string | null {
  if (settings.customDomain) return `https://${settings.customDomain}/`
  return settings.projectName ? `https://${settings.projectName}.pages.dev/` : null
}

/** A domain as typed (`artifacts.example.com`, or an address on it) as stored: the bare host. Null when it is not one. */
function normalizeDomain(input: string): string | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  return HOST_PATTERN.test(text) && text.includes('.') && !text.includes(':') ? text : null
}

type FieldFailure = { ok: false; field: ArtifactsSettingsField; message: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The setting as stored, from a write. Each host's fields are kept while the
 * other is chosen, so switching back loses nothing; only the chosen host's
 * fields have to be complete. Choosing no host is always accepted.
 */
export function validateArtifactsSettings(input: unknown): { ok: true; settings: ArtifactsSettings } | FieldFailure {
  const raw = recordOf(input)
  const provider = raw.provider === null || raw.provider === undefined || raw.provider === '' ? null : raw.provider
  if (provider !== null && !ARTIFACTS_PROVIDERS.includes(provider as ArtifactsProviderKind)) {
    return { ok: false, field: 'provider', message: 'Choose GitHub Pages or Cloudflare Pages.' }
  }
  const github = recordOf(raw.github)
  const cloudflare = recordOf(raw.cloudflare)
  const settings: ArtifactsSettings = {
    provider: provider as ArtifactsProviderKind | null,
    github: { repositoryUrl: text(github.repositoryUrl), pagesUrl: text(github.pagesUrl) },
    cloudflare: {
      accountId: text(cloudflare.accountId).toLowerCase(),
      projectName: text(cloudflare.projectName).toLowerCase(),
      customDomain: text(cloudflare.customDomain),
      repositoryUrl: text(cloudflare.repositoryUrl),
    },
  }

  // A sign-in typed into either repository address is refused whichever host
  // is chosen: it would sit in plain settings. Beyond that only the chosen
  // host's fields are checked; the other's are kept as typed, and checked
  // when that host is chosen, so a half-filled tab never blocks the other.
  for (const [field, value] of [
    ['github.repositoryUrl', settings.github.repositoryUrl],
    ['cloudflare.repositoryUrl', settings.cloudflare.repositoryUrl],
  ] as const) {
    if (value && hasSignIn(value)) return { ok: false, field, message: SIGN_IN_REFUSED }
  }
  if (settings.provider === 'github-pages') {
    if (settings.github.repositoryUrl) {
      const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
      if (!parsed.ok) return { ok: false, field: 'github.repositoryUrl', message: parsed.message }
    }
    if (settings.github.pagesUrl) {
      const pagesUrl = normalizeSiteUrl(settings.github.pagesUrl)
      if (!pagesUrl) {
        return {
          ok: false,
          field: 'github.pagesUrl',
          message: 'Enter the site’s address as an https URL, such as https://acme.github.io/artifacts/.',
        }
      }
      settings.github.pagesUrl = pagesUrl
    }
  }
  if (settings.provider === 'cloudflare-pages') {
    if (settings.cloudflare.accountId && !ACCOUNT_ID_PATTERN.test(settings.cloudflare.accountId)) {
      return {
        ok: false,
        field: 'cloudflare.accountId',
        message:
          'The account ID is 32 letters and digits, shown on the account’s overview page in the Cloudflare dashboard.',
      }
    }
    if (settings.cloudflare.projectName && !PROJECT_NAME_PATTERN.test(settings.cloudflare.projectName)) {
      return {
        ok: false,
        field: 'cloudflare.projectName',
        message: 'A Pages project name is lowercase letters, digits and hyphens, at most 58 characters.',
      }
    }
    if (settings.cloudflare.customDomain) {
      const domain = normalizeDomain(settings.cloudflare.customDomain)
      if (!domain)
        return {
          ok: false,
          field: 'cloudflare.customDomain',
          message: 'Enter a domain, such as artifacts.example.com.',
        }
      settings.cloudflare.customDomain = domain
    }
    if (settings.cloudflare.repositoryUrl) {
      const parsed = parseArtifactsRepositoryUrl(settings.cloudflare.repositoryUrl)
      if (!parsed.ok) return { ok: false, field: 'cloudflare.repositoryUrl', message: parsed.message }
    }
  }

  if (settings.provider === 'github-pages') {
    if (!settings.github.repositoryUrl) {
      return {
        ok: false,
        field: 'github.repositoryUrl',
        message: 'Enter the repository GitHub Pages serves the site from.',
      }
    }
    const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
    if (parsed.ok && !settings.github.pagesUrl && !defaultGitHubPagesUrl(parsed.repository)) {
      return { ok: false, field: 'github.pagesUrl', message: 'Enter the address the site is served at.' }
    }
  }
  if (settings.provider === 'cloudflare-pages') {
    if (!settings.cloudflare.accountId) {
      return { ok: false, field: 'cloudflare.accountId', message: 'Enter the Cloudflare account ID.' }
    }
    if (!settings.cloudflare.projectName) {
      return { ok: false, field: 'cloudflare.projectName', message: 'Enter the Pages project’s name.' }
    }
  }
  return { ok: true, settings }
}

/** The gallery's address for the chosen host, or null while it is not set up. */
export function artifactsSiteUrl(settings: ArtifactsSettings): string | null {
  if (settings.provider === 'github-pages') {
    if (settings.github.pagesUrl) return settings.github.pagesUrl
    const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
    return parsed.ok ? defaultGitHubPagesUrl(parsed.repository) : null
  }
  if (settings.provider === 'cloudflare-pages') return cloudflareSiteUrl(settings.cloudflare)
  return null
}

/** The Pages address the GitHub repository would get, or null. */
export function derivedGitHubPagesUrl(settings: ArtifactsSettings): string | null {
  const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
  return parsed.ok ? defaultGitHubPagesUrl(parsed.repository) : null
}
