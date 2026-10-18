import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import {
  ARTIFACTS_SETTINGS_PAGE,
  ARTIFACTS_SETUP_TOOL,
  cloudflareProjectName,
  defaultGitHubPagesUrl,
  isArtifactsHostReady,
  parseArtifactsRepositoryUrl,
  type ArtifactsCheck,
  type ArtifactsProviderKind,
  type ArtifactsRepository,
  type ArtifactsSettings,
} from '../../shared/artifacts'
import {
  createGitStore,
  createLocalStore,
  repositoryLabel,
  type ArtifactsChange,
  type ArtifactsStore,
  type GitStoreDeps,
} from './artifacts-store'
import { defaultSiteFetch, syncLiveCopy, type SiteFetch } from './cloudflare-live-copy'
import {
  createCloudflarePagesClient,
  STUDIO_DEPLOYMENT_PREFIX,
  type CloudflareFetch,
  type CloudflarePagesFile,
} from './cloudflare-pages-client'
import { ensurePages, waitForPagesBuild, type GhApi } from './github-pages'

// Where artifacts are hosted, behind one shape the service, the tools and the
// set-up use whatever the person chose on Settings ▸ Artifacts. A host keeps
// the site's source in a store (artifacts-store.ts) and puts it live:
//
// - GitHub Pages: the store is the repository, and a push to main is the
//   deployment. After each change, still in the store's queue (so never ahead
//   of main existing, and never twice at once), Pages is turned on if it is
//   off and its address read back; the first build is waited for.
// - Cloudflare Pages: the store is a repository when one is set under
//   Advanced, or a folder here brought up to the live site first
//   (cloudflare-live-copy.ts); once a change is kept the whole site goes up
//   with Direct Upload.
//
// A third host is another `create…Host` returning the same shape, and a case
// in `resolveArtifactsHost`.

export type ArtifactsHostChange<T> =
  | {
      ok: true
      value: T | null
      commit: string | null
      /** Why the change, though kept, is not live yet. */
      notLive?: string
      /** What putting it live found or did, for the set-up's report. */
      steps: ArtifactsCheck[]
    }
  | { ok: false; message: string }

export type ArtifactsHost = {
  readonly kind: ArtifactsProviderKind
  /** For messages: `GitHub Pages (acme/artifacts on github.com)`. */
  readonly label: string
  /** The gallery's address, ending in a slash: as the host last answered it. */
  siteUrl(): string
  read<T>(
    work: (dir: string) => Promise<T>,
  ): Promise<{ ok: true; value: T; stale: boolean } | { ok: false; message: string }>
  /** Change the site's source and put it live. */
  change<T>(work: ArtifactsChange<T>): Promise<ArtifactsHostChange<T>>
}

export type ArtifactsHostDeps = GitStoreDeps & {
  /** Studio's data folder for artifacts: clones and the Cloudflare site live under it. */
  dataDir: string
  /** The Cloudflare API token, or ''. */
  cloudflareToken: () => Promise<string>
  /** `gh api`, for GitHub Pages. Left out, Pages is neither read nor turned on. */
  ghApi?: GhApi
  fetch?: CloudflareFetch
  cloudflareApiBase?: string
  /** A GET of the live site, for a Cloudflare copy that is behind. */
  siteFetch?: SiteFetch
  /** How long a first GitHub Pages build is waited for; two minutes by default. */
  pagesBuildTimeoutMs?: number
  pagesBuildIntervalMs?: number
  /** The site's address as the host answered it, for the setting to keep. */
  onSiteUrl?: (kind: ArtifactsProviderKind, url: string) => void
}

export type ResolvedArtifactsHost =
  { ok: true; host: ArtifactsHost } | { ok: false; code: 'not_configured'; message: string }

export const NOT_CONFIGURED_MESSAGE =
  `Artifacts have nowhere to be published yet. The person chooses GitHub Pages or Cloudflare Pages on ${ARTIFACTS_SETTINGS_PAGE}, ` +
  `or you can offer to set it up with ${ARTIFACTS_SETUP_TOOL} (a GitHub repository, or a Cloudflare API token, ` +
  'from the person); Studio asks the person to confirm before anything is changed.'

/** The host Settings ▸ Artifacts names, or why there is none. */
export function resolveArtifactsHost(settings: ArtifactsSettings, deps: ArtifactsHostDeps): ResolvedArtifactsHost {
  if (!isArtifactsHostReady(settings)) return { ok: false, code: 'not_configured', message: NOT_CONFIGURED_MESSAGE }
  if (settings.provider === 'github-pages') {
    const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
    if (parsed.ok) {
      return {
        ok: true,
        host: createGitHubPagesHost({ repository: parsed.repository, siteUrl: settings.github.siteUrl, deps }),
      }
    }
  }
  if (settings.provider === 'cloudflare-pages') return { ok: true, host: createCloudflarePagesHost({ settings, deps }) }
  return { ok: false, code: 'not_configured', message: NOT_CONFIGURED_MESSAGE }
}

export function createGitHubPagesHost(input: {
  repository: ArtifactsRepository
  /** The address Pages last answered; empty until it has. */
  siteUrl: string
  deps: ArtifactsHostDeps
}): ArtifactsHost {
  const { repository, deps } = input
  const store = createGitStore({ repository, checkoutRoot: join(deps.dataDir, 'repositories'), deps })
  // Until Pages answers, the address it would give; never shown as found.
  let siteUrl = input.siteUrl || defaultGitHubPagesUrl(repository) || ''
  let steps: ArtifactsCheck[] = []

  const putLive = async (): Promise<string | null> => {
    steps = []
    if (!deps.ghApi) return null
    const pages = await ensurePages(deps.ghApi, repository)
    if (!pages.ok) {
      steps.push({ label: 'Pages', status: 'fail', detail: pages.message })
      return pages.message
    }
    if (pages.site.url !== siteUrl || !input.siteUrl) {
      siteUrl = pages.site.url
      deps.onSiteUrl?.('github-pages', siteUrl)
    }
    steps.push(
      pages.turnedOn
        ? {
            label: 'Pages',
            status: 'pass',
            detail: `Turned on GitHub Pages for ${repositoryLabel(repository)}, from main.`,
          }
        : {
            label: 'Pages',
            status: pages.site.branch && pages.site.branch !== 'main' ? 'warn' : 'pass',
            detail:
              pages.site.branch && pages.site.branch !== 'main'
                ? `GitHub Pages is on but builds ${pages.site.branch}; set it to deploy from main, / (root), in the repository’s Settings ▸ Pages.`
                : 'Found GitHub Pages on, serving main.',
          },
    )
    // The first build: a new site answers 404 until it is done.
    if (pages.turnedOn || pages.site.status === null) {
      const built = await waitForPagesBuild(deps.ghApi, repository, {
        timeoutMs: deps.pagesBuildTimeoutMs ?? 120_000,
        ...(deps.pagesBuildIntervalMs !== undefined ? { intervalMs: deps.pagesBuildIntervalMs } : {}),
      })
      if (built === 'errored') {
        const message = `GitHub Pages could not build the site; its error is under the repository’s Actions (the “pages build and deployment” run).`
        steps.push({ label: 'Build', status: 'fail', detail: message })
        return message
      }
      if (built === 'timeout') {
        const message = `GitHub Pages is still building the site for the first time; it will be at ${siteUrl} in a few minutes.`
        steps.push({ label: 'Build', status: 'warn', detail: message })
        return message
      }
      steps.push({ label: 'Build', status: 'pass', detail: 'GitHub Pages built the site.' })
    }
    steps.push({ label: 'Site', status: 'pass', detail: siteUrl })
    return null
  }

  return {
    kind: 'github-pages',
    label: `GitHub Pages (${repositoryLabel(repository)})`,
    siteUrl: () => siteUrl,
    read: (work) => store.read(work),
    async change(work) {
      const changed = await store.change(work, () => putLive())
      if (!changed.ok) return changed
      const { afterFailure, ...rest } = changed
      return {
        ...rest,
        steps,
        ...(afterFailure
          ? {
              notLive: steps.some((step) => step.status === 'fail')
                ? `Saved to ${store.label}, but not live: ${afterFailure}`
                : afterFailure,
            }
          : {}),
      }
    },
  }
}

/** Every file of the site, as Pages takes it: no git folder, no hidden files. */
async function siteFiles(root: string): Promise<CloudflarePagesFile[]> {
  const files: CloudflarePagesFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile())
        files.push({ path: relative(root, path).split(sep).join('/'), bytes: await readFile(path) })
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** One digest of the whole site, so an unchanged site is not uploaded again. */
function siteDigest(files: CloudflarePagesFile[]): string {
  const hash = createHash('sha256')
  for (const file of files)
    hash.update(file.path).update('\0').update(createHash('sha256').update(file.bytes).digest()).update('\0')
  return hash.digest('hex')
}

type DeployedState = { accountId: string; project: string; digest: string; deploymentId: string | null }

export function createCloudflarePagesHost(input: {
  settings: ArtifactsSettings
  deps: ArtifactsHostDeps
  /** A token not yet saved (the set-up's); the saved one otherwise. */
  token?: string
  dryRun?: boolean
}): ArtifactsHost {
  const { settings, deps } = input
  const { accountId, repositoryUrl } = settings.cloudflare
  const projectName = cloudflareProjectName(settings.cloudflare)
  let siteUrl = settings.cloudflare.siteUrl || `https://${projectName}.pages.dev/`
  const token = input.token !== undefined ? async () => input.token as string : deps.cloudflareToken
  const client = createCloudflarePagesClient({
    accountId,
    projectName,
    token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.cloudflareApiBase ? { apiBase: deps.cloudflareApiBase } : {}),
  })
  const parsed = repositoryUrl ? parseArtifactsRepositoryUrl(repositoryUrl) : null
  const repository = parsed?.ok ? parsed.repository : null
  const localDir = join(deps.dataDir, 'cloudflare', `${accountId.slice(0, 12)}-${projectName}`)
  // What was last put live, beside the copy, so a change kept while the
  // upload failed goes up with the next, and a copy that is behind is known.
  const statePath = join(deps.dataDir, 'cloudflare', `${accountId.slice(0, 12)}-${projectName}.deployed.json`)
  let steps: ArtifactsCheck[] = []

  const lastDeployed = async (): Promise<DeployedState | null> => {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as Partial<DeployedState>
      return raw.accountId === accountId && raw.project === projectName && typeof raw.digest === 'string'
        ? { accountId, project: projectName, digest: raw.digest, deploymentId: raw.deploymentId ?? null }
        : null
    } catch {
      return null
    }
  }

  /**
   * The local copy brought up to what is live, when something other than
   * this copy was deployed since: another machine, or this one before its
   * data folder was cleared.
   */
  const bringCopyUp = async (dir: string): Promise<string | null> => {
    const latest = await client.latestDeployment()
    if (!latest.ok) return latest.message
    if (!latest.deployed) return null
    const state = await lastDeployed()
    if (state?.deploymentId && state.deploymentId === latest.id) return null
    const synced = await syncLiveCopy(dir, siteUrl, deps.siteFetch ?? defaultSiteFetch)
    switch (synced.state) {
      case 'rebuilt':
        steps.push({
          label: 'Copy',
          status: 'pass',
          detail: `Rebuilt this machine’s copy of the site from ${siteUrl} (${synced.artifacts} artifact${synced.artifacts === 1 ? '' : 's'}).`,
        })
        return null
      case 'merged':
        if (synced.taken.length) {
          steps.push({
            label: 'Copy',
            status: 'pass',
            detail: `Took ${synced.taken.length} artifact${synced.taken.length === 1 ? '' : 's'} published elsewhere from ${siteUrl}.`,
          })
        }
        return null
      case 'empty':
        return null
      case 'behind-access':
        return (
          `${siteUrl} is behind Cloudflare Access, so Studio cannot read it back to bring this machine’s copy of the site up to date, ` +
          'and something was published to it from elsewhere since this machine last did. Publish from the machine that did, ' +
          `or set a source repository under Advanced on ${ARTIFACTS_SETTINGS_PAGE} so every machine shares one copy.`
        )
      case 'unreachable':
        return `Could not read ${siteUrl} to bring this machine’s copy of the site up to date: ${synced.message}`
    }
  }

  const store: ArtifactsStore = repository
    ? createGitStore({ repository, checkoutRoot: join(deps.dataDir, 'repositories'), deps })
    : createLocalStore({ dir: localDir, prepare: bringCopyUp })

  const putLive = async (dir: string, commit: string | null): Promise<string | null> => {
    const files = await siteFiles(dir)
    if (!files.length) return null
    const digest = siteDigest(files)
    if (!input.dryRun && digest === (await lastDeployed())?.digest) return null
    const deployed = await client.deploy(files, {
      commitMessage: commit ? `${STUDIO_DEPLOYMENT_PREFIX} at ${commit.slice(0, 12)}` : STUDIO_DEPLOYMENT_PREFIX,
      commitHash: commit,
      dryRun: input.dryRun,
    })
    if (!deployed.ok) {
      steps.push({ label: 'Upload', status: 'fail', detail: deployed.message })
      return deployed.message
    }
    if (!deployed.dryRun) {
      const state: DeployedState = { accountId, project: projectName, digest, deploymentId: deployed.deploymentId }
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, `${JSON.stringify({ ...state, commit, at: new Date().toISOString() })}\n`)
    }
    steps.push({
      label: 'Upload',
      status: 'pass',
      detail: deployed.dryRun
        ? `A dry run of the upload went through: ${deployed.files} files, ${deployed.uploaded} of them new. Nothing was deployed.`
        : `Uploaded the site: ${deployed.uploaded} new file${deployed.uploaded === 1 ? '' : 's'} of ${deployed.files}.`,
    })
    return null
  }

  return {
    kind: 'cloudflare-pages',
    label: `Cloudflare Pages (${projectName})`,
    siteUrl: () => siteUrl,
    read: (work) => store.read(work),
    async change(work) {
      steps = []
      const changed = await store.change(work, putLive)
      if (!changed.ok) return changed
      const { afterFailure, ...rest } = changed
      return afterFailure
        ? {
            ...rest,
            steps,
            notLive: `${repository ? `Saved to ${store.label}` : 'Saved on this machine'}, but not live on Cloudflare Pages yet: ${afterFailure} The next publish or update uploads it again.`,
          }
        : { ...rest, steps }
    },
  }
}

/** For the set-up: the address a found or made project serves, its own domain first. */
export function cloudflareProjectSiteUrl(
  project: { subdomain: string | null; domains: string[] },
  fallback: string,
): string {
  const custom = project.domains.find((domain) => !domain.endsWith('.pages.dev'))
  if (custom) return `https://${custom}/`
  return project.subdomain ? `https://${project.subdomain}/` : fallback
}

/** Lets a changed site address from a host reach the setting. */
export function settingsWithSiteUrl(
  settings: ArtifactsSettings,
  kind: ArtifactsProviderKind,
  url: string,
): ArtifactsSettings {
  if (kind === 'github-pages' && settings.provider === 'github-pages')
    return { ...settings, github: { ...settings.github, siteUrl: url } }
  if (kind === 'cloudflare-pages' && settings.provider === 'cloudflare-pages') {
    return { ...settings, cloudflare: { ...settings.cloudflare, siteUrl: url } }
  }
  return settings
}
