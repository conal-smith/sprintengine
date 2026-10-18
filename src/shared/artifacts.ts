// Published artifacts: where the `artifacts.*` tools publish an agent's HTML
// mockups so they can be opened from any device. The person picks one host on
// Settings ▸ Artifacts, and each asks for one thing:
//
// - GitHub Pages: the repository. Studio turns Pages on for it when it is off
//   and reads the site's address back from GitHub, so a custom domain works.
// - Cloudflare Pages: an API token. Studio finds the account (the person picks
//   one when the token sees several) and finds or makes the project.
//
// Everything else is what Studio found, kept so it need not ask again. Until a
// host is set up the tools refuse, naming the page and `artifacts.setup`, the
// tool an agent offers the person to set it up in conversation.

/** Where the setting lives, as the tools' refusal and the docs name it. */
export const ARTIFACTS_SETTINGS_PAGE = 'Settings ▸ Artifacts'

/** The tool an agent sets a host up with, the person confirming in Studio. */
export const ARTIFACTS_SETUP_TOOL = 'artifacts.setup'

export const ARTIFACTS_PROVIDERS = ['github-pages', 'cloudflare-pages'] as const
export type ArtifactsProviderKind = (typeof ARTIFACTS_PROVIDERS)[number]

/** The Pages project Studio looks for, and makes when there is none, unless told another name. */
export const DEFAULT_CLOUDFLARE_PROJECT = 'studio-artifacts'

/**
 * Cloudflare's page for a new API token, with the one permission the
 * artifacts need preselected (Account › Cloudflare Pages › Edit) and a name.
 */
export const CLOUDFLARE_TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(JSON.stringify([{ key: 'page', type: 'edit' }])) +
  '&name=' +
  encodeURIComponent('SprintEngine Studio artifacts')

export type GitHubPagesSettings = {
  /** The repository as the person gave it: an https or ssh URL, or `owner/name` on github.com. */
  repositoryUrl: string
  /** The site's address as GitHub Pages answered it (`html_url`); Studio's to fill. */
  siteUrl: string
}

export type CloudflarePagesSettings = {
  /** The account the token sees, as found (or picked); Studio's to fill. */
  accountId: string
  accountName: string
  /** The project's name, when not the default; under Advanced. */
  projectName: string
  /** A git repository to keep the site's source and history in, when wanted; under Advanced. */
  repositoryUrl: string
  /** The site's address as the project answered it; Studio's to fill. */
  siteUrl: string
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
}

/** What the person (or an agent, with the person's confirmation) asks to set up. */
export type ArtifactsSetupInput =
  | { provider: null }
  | { provider: 'github-pages'; repositoryUrl: string }
  | {
      provider: 'cloudflare-pages'
      /** A new token; left out, the saved one. */
      token?: string
      /** The account to use, when the token sees several. */
      accountId?: string
      projectName?: string
      repositoryUrl?: string
    }

export type ArtifactsSetupField =
  | 'provider'
  | 'github.repositoryUrl'
  | 'cloudflare.token'
  | 'cloudflare.accountId'
  | 'cloudflare.projectName'
  | 'cloudflare.repositoryUrl'

/**
 * One line of a set-up or a check: what was looked at or done, how it went,
 * and what it found. `warn` passed with something left to do (Pages still
 * building): publishing works, the site may not show it yet.
 */
export type ArtifactsCheck = { label: string; status: 'pass' | 'warn' | 'fail'; detail: string }

export type ArtifactsSetupResult =
  | { ok: true; steps: ArtifactsCheck[]; siteUrl: string | null; saved: boolean; view: ArtifactsSettingsView }
  | {
      ok: false
      steps: ArtifactsCheck[]
      field?: ArtifactsSetupField
      message: string
      /** The token sees several accounts: the person picks one, and it is asked again with `accountId`. */
      accounts?: Array<{ id: string; name: string }>
    }

/** The set-up question as a Studio window shows it, until it is answered or expires. */
export type ArtifactsSetupQuestionView = {
  id: string
  message: string
  detail: string
  confirmLabel: string
  refuseLabel: string
  expiresAt: number
}

export const EMPTY_ARTIFACTS_SETTINGS: ArtifactsSettings = {
  provider: null,
  github: { repositoryUrl: '', siteUrl: '' },
  cloudflare: { accountId: '', accountName: '', projectName: '', repositoryUrl: '', siteUrl: '' },
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

/** The name of the Pages project to use: the one asked for, or the default. */
export function cloudflareProjectName(settings: Pick<CloudflarePagesSettings, 'projectName'>): string {
  return settings.projectName || DEFAULT_CLOUDFLARE_PROJECT
}

export function isCloudflareProjectName(name: string): boolean {
  return PROJECT_NAME_PATTERN.test(name)
}

export function isCloudflareAccountId(id: string): boolean {
  return ACCOUNT_ID_PATTERN.test(id)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The setting as stored, from what is on disk: anything malformed reads as
 * empty rather than failing, and a host whose required fields are missing is
 * kept chosen (the tools then say it is not set up). Only Studio writes this
 * file, through `setUpArtifacts`, which checks what it is given first.
 */
export function readArtifactsSettings(input: unknown): ArtifactsSettings {
  const raw = recordOf(input)
  const provider = ARTIFACTS_PROVIDERS.includes(raw.provider as ArtifactsProviderKind)
    ? (raw.provider as ArtifactsProviderKind)
    : null
  const github = recordOf(raw.github)
  const cloudflare = recordOf(raw.cloudflare)
  const repository = (value: unknown) => {
    const url = text(value)
    return url && parseArtifactsRepositoryUrl(url).ok ? url : ''
  }
  const site = (value: unknown) => normalizeSiteUrl(text(value)) ?? ''
  const accountId = text(cloudflare.accountId).toLowerCase()
  const projectName = text(cloudflare.projectName).toLowerCase()
  return {
    provider,
    github: { repositoryUrl: repository(github.repositoryUrl), siteUrl: site(github.siteUrl) },
    cloudflare: {
      accountId: ACCOUNT_ID_PATTERN.test(accountId) ? accountId : '',
      accountName: text(cloudflare.accountName).slice(0, 200),
      projectName: PROJECT_NAME_PATTERN.test(projectName) ? projectName : '',
      repositoryUrl: repository(cloudflare.repositoryUrl),
      siteUrl: site(cloudflare.siteUrl),
    },
  }
}

/** The gallery's address for the chosen host, as Studio found it, or null while it is not set up. */
export function artifactsSiteUrl(settings: ArtifactsSettings): string | null {
  if (settings.provider === 'github-pages') return settings.github.siteUrl || null
  if (settings.provider === 'cloudflare-pages') return settings.cloudflare.siteUrl || null
  return null
}

/** Whether the chosen host has what the tools need to publish. */
export function isArtifactsHostReady(settings: ArtifactsSettings): boolean {
  if (settings.provider === 'github-pages') return settings.github.repositoryUrl !== ''
  if (settings.provider === 'cloudflare-pages') return settings.cloudflare.accountId !== ''
  return false
}
