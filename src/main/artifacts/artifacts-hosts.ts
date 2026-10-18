import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import {
  ARTIFACTS_SETTINGS_PAGE,
  artifactsSiteUrl,
  parseArtifactsRepositoryUrl,
  type ArtifactsCheck,
  type ArtifactsProviderKind,
  type ArtifactsRepository,
  type ArtifactsSettings,
  type ArtifactsTestResult,
} from '../../shared/artifacts'
import {
  createGitStore,
  createLocalStore,
  repositoryLabel,
  type ArtifactsChange,
  type ArtifactsStore,
  type GitStoreDeps,
} from './artifacts-store'
import { createCloudflarePagesClient, type CloudflareFetch, type CloudflarePagesFile } from './cloudflare-pages-client'

// Where artifacts are hosted, behind one shape the service and the tools use
// whatever the person chose on Settings ▸ Artifacts. A host keeps the site's
// source in a store (artifacts-store.ts) and puts it live:
//
// - GitHub Pages: the store is the repository, and a push to main is the
//   deployment; Pages builds the branch as it is.
// - Cloudflare Pages: the store is a repository when one is set, or a folder
//   here; once a change is kept, the whole site is uploaded to the project
//   with Direct Upload (cloudflare-pages-client.ts).
//
// A third host is another `create…Host` returning the same shape, and a case
// in `resolveArtifactsHost`.

export type ArtifactsHost = {
  readonly kind: ArtifactsProviderKind
  /** For messages: `GitHub Pages (acme/artifacts on github.com)`. */
  readonly label: string
  /** The gallery's address, ending in a slash. */
  readonly siteUrl: string
  read<T>(
    work: (dir: string) => Promise<T>,
  ): Promise<{ ok: true; value: T; stale: boolean } | { ok: false; message: string }>
  /**
   * Change the site's source and put it live. A change that was kept but
   * could not be put live answers ok with `notLive`, saying why; the next
   * change puts it live with everything since.
   */
  change<T>(
    work: ArtifactsChange<T>,
  ): Promise<{ ok: true; value: T | null; commit: string | null; notLive?: string } | { ok: false; message: string }>
  /** Check the configuration without publishing anything. */
  test(): Promise<ArtifactsTestResult>
}

/** `gh api` against a host, for the checks only: the GitHub Pages status of a repository. */
export type GhApi = (
  host: string,
  path: string,
) => Promise<{ ok: true; json: unknown } | { ok: false; status: number | null; message: string }>

export type ArtifactsHostDeps = GitStoreDeps & {
  /** Studio's data folder for artifacts: clones and the Cloudflare site live under it. */
  dataDir: string
  /** The Cloudflare API token, or ''. */
  cloudflareToken: () => Promise<string>
  ghApi?: GhApi
  fetch?: CloudflareFetch
  cloudflareApiBase?: string
}

export type ResolvedArtifactsHost =
  { ok: true; host: ArtifactsHost } | { ok: false; code: 'not_configured'; message: string }

const NOT_CONFIGURED =
  `Artifacts have nowhere to be published yet. Choose GitHub Pages or Cloudflare Pages on ${ARTIFACTS_SETTINGS_PAGE} ` +
  '(the person sets it up; an agent cannot), then try again.'

function result(checks: ArtifactsCheck[]): ArtifactsTestResult {
  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

/** The host Settings ▸ Artifacts names, or why there is none. */
export function resolveArtifactsHost(settings: ArtifactsSettings, deps: ArtifactsHostDeps): ResolvedArtifactsHost {
  const siteUrl = artifactsSiteUrl(settings)
  if (settings.provider === 'github-pages' && siteUrl) {
    const parsed = parseArtifactsRepositoryUrl(settings.github.repositoryUrl)
    if (parsed.ok) return { ok: true, host: createGitHubPagesHost({ repository: parsed.repository, siteUrl, deps }) }
  }
  if (
    settings.provider === 'cloudflare-pages' &&
    siteUrl &&
    settings.cloudflare.accountId &&
    settings.cloudflare.projectName
  ) {
    return { ok: true, host: createCloudflarePagesHost({ settings, siteUrl, deps }) }
  }
  return { ok: false, code: 'not_configured', message: NOT_CONFIGURED }
}

export function createGitHubPagesHost(input: {
  repository: ArtifactsRepository
  siteUrl: string
  deps: ArtifactsHostDeps
}): ArtifactsHost {
  const { repository, siteUrl, deps } = input
  const store = createGitStore({ repository, checkoutRoot: join(deps.dataDir, 'repositories'), deps })
  return {
    kind: 'github-pages',
    label: `GitHub Pages (${repositoryLabel(repository)})`,
    siteUrl,
    read: (work) => store.read(work),
    async change(work) {
      return store.change(work)
    },
    async test() {
      const checks = await store.test()
      if (repository.transport !== 'file' && deps.ghApi && !checks.some((check) => check.status === 'fail')) {
        const pages = await deps.ghApi(repository.host, `repos/${repository.owner}/${repository.name}/pages`)
        if (pages.ok) {
          const info = (pages.json ?? {}) as { html_url?: unknown; source?: { branch?: unknown; path?: unknown } }
          const branch = typeof info.source?.branch === 'string' ? info.source.branch : null
          const path = typeof info.source?.path === 'string' ? info.source.path : null
          const servesMain = branch === 'main' && (path === '/' || path === null)
          checks.push({
            label: 'Pages',
            status: servesMain ? 'pass' : 'warn',
            detail: servesMain
              ? `GitHub Pages serves main${typeof info.html_url === 'string' ? ` at ${info.html_url}` : ''}.`
              : `GitHub Pages builds ${branch ?? 'another source'}${path ? ` (${path})` : ''}; set it to deploy from the main branch, / (root), in the repository’s Settings ▸ Pages.`,
          })
        } else if (pages.status === 404) {
          checks.push({
            label: 'Pages',
            status: 'warn',
            detail:
              'GitHub Pages is not turned on for this repository yet. Publishing works; the site appears once Pages deploys from the main branch, / (root), in the repository’s Settings ▸ Pages.',
          })
        } else {
          checks.push({ label: 'Pages', status: 'warn', detail: `Could not read the Pages status: ${pages.message}` })
        }
      }
      return result(checks)
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

export function createCloudflarePagesHost(input: {
  settings: ArtifactsSettings
  siteUrl: string
  deps: ArtifactsHostDeps
  dryRun?: boolean
}): ArtifactsHost {
  const { settings, siteUrl, deps } = input
  const { accountId, projectName, repositoryUrl, customDomain } = settings.cloudflare
  const parsed = repositoryUrl ? parseArtifactsRepositoryUrl(repositoryUrl) : null
  const repository = parsed?.ok ? parsed.repository : null
  const store: ArtifactsStore = repository
    ? createGitStore({ repository, checkoutRoot: join(deps.dataDir, 'repositories'), deps })
    : createLocalStore({ dir: join(deps.dataDir, 'cloudflare', `${accountId.slice(0, 12)}-${projectName}`) })
  const client = createCloudflarePagesClient({
    accountId,
    projectName,
    token: deps.cloudflareToken,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.cloudflareApiBase ? { apiBase: deps.cloudflareApiBase } : {}),
  })
  // What was last put live, beside the store, so a change kept while the
  // upload failed is uploaded by the next one.
  const statePath = join(dirname(store.dir), `${projectName}.cloudflare-deployed.json`)
  const lastDeployed = async (): Promise<string | null> => {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as { digest?: unknown; accountId?: unknown }
      return raw.accountId === accountId && typeof raw.digest === 'string' ? raw.digest : null
    } catch {
      return null
    }
  }

  const putLive = async (dir: string, commit: string | null): Promise<string | null> => {
    const files = await siteFiles(dir)
    if (!files.length) return null
    const digest = siteDigest(files)
    if (!input.dryRun && digest === (await lastDeployed())) return null
    const deployed = await client.deploy(files, {
      commitMessage: commit ? `Artifacts at ${commit.slice(0, 12)}` : 'Artifacts',
      commitHash: commit,
      dryRun: input.dryRun,
    })
    if (!deployed.ok) return deployed.message
    if (!deployed.dryRun) {
      await writeFile(statePath, `${JSON.stringify({ accountId, digest, commit, at: new Date().toISOString() })}\n`)
    }
    return null
  }

  return {
    kind: 'cloudflare-pages',
    label: `Cloudflare Pages (${projectName})`,
    siteUrl,
    read: (work) => store.read(work),
    async change(work) {
      const changed = await store.change(work, putLive)
      if (!changed.ok) return changed
      const { afterFailure, ...rest } = changed
      return afterFailure
        ? {
            ...rest,
            notLive: `${repository ? `Saved to ${store.label}` : 'Saved on this machine'}, but not live on Cloudflare Pages yet: ${afterFailure} The next publish or update uploads it again.`,
          }
        : rest
    },
    async test() {
      const checks: ArtifactsCheck[] = []
      const token = await deps.cloudflareToken()
      if (!token) {
        checks.push({ label: 'API token', status: 'fail', detail: 'No API token is saved.' })
        return result(checks)
      }
      const verified = await client.verifyToken()
      checks.push(
        verified.ok
          ? { label: 'API token', status: 'pass', detail: 'Cloudflare accepts the token.' }
          : { label: 'API token', status: 'fail', detail: verified.message },
      )
      if (!verified.ok) return result(checks)
      const found = await client.project()
      if (!found.ok) {
        checks.push({ label: 'Project', status: 'fail', detail: found.message })
        return result(checks)
      }
      if (found.project.sourceType) {
        checks.push({
          label: 'Project',
          status: 'fail',
          detail: `"${projectName}" deploys from its own ${found.project.sourceType} connection, which takes no direct upload. Use a project created with Direct Upload.`,
        })
        return result(checks)
      }
      checks.push({
        label: 'Project',
        status: 'pass',
        detail: `Found "${found.project.name}", served at ${found.project.subdomain ? `https://${found.project.subdomain}/` : siteUrl}.`,
      })
      if (customDomain) {
        const listed = found.project.domains.includes(customDomain)
        checks.push({
          label: 'Custom domain',
          status: listed ? 'pass' : 'warn',
          detail: listed
            ? `${customDomain} is one of the project’s domains.`
            : `${customDomain} is not among the project’s domains yet; add it under the project’s Custom domains.`,
        })
      }
      checks.push(...(await store.test()))
      // The upload, rehearsed: Cloudflare hands out an upload token (which
      // needs Pages Edit) and compares the site with what it has, and nothing
      // is uploaded or deployed.
      const rehearsed = await store.read(async (dir) => {
        const files = await siteFiles(dir)
        return files.length ? client.deploy(files, { commitMessage: 'Check', dryRun: true }) : null
      })
      if (rehearsed.ok && rehearsed.value) {
        const value = rehearsed.value
        checks.push(
          value.ok
            ? {
                label: 'Upload',
                status: 'pass',
                detail: `A dry run of the upload went through: ${value.files} files, ${value.uploaded} of them new to Pages. Nothing was deployed.`,
              }
            : { label: 'Upload', status: 'fail', detail: value.message },
        )
      }
      return result(checks)
    },
  }
}
