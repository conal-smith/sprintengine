import { join } from 'node:path'

import {
  cloudflareProjectName,
  DEFAULT_CLOUDFLARE_PROJECT,
  isCloudflareProjectName,
  parseArtifactsRepositoryUrl,
  type ArtifactsCheck,
  type ArtifactsSettings,
  type ArtifactsSetupField,
  type ArtifactsSetupInput,
  type ArtifactsSetupResult,
} from '../../shared/artifacts'
import { finishSiteTree, type ArtifactsSiteTemplate } from './artifact-site'
import {
  cloudflareProjectSiteUrl,
  createCloudflarePagesHost,
  createGitHubPagesHost,
  type ArtifactsHost,
  type ArtifactsHostDeps,
} from './artifacts-hosts'
import type { ArtifactsSettingsStore } from './artifacts-settings-store'
import { createGitStore } from './artifacts-store'
import { createCloudflarePagesClient, listCloudflareAccounts } from './cloudflare-pages-client'

// Setting a host up from the one thing the person gives it, for Settings'
// Test and Save and for `artifacts.setup`:
//
// - GitHub Pages, from the repository: it is read and a push rehearsed; the
//   site's first commit is pushed when the repository is empty; Pages is
//   turned on when it is off (main, /) and its address read back; the first
//   build is waited for.
// - Cloudflare Pages, from an API token: the accounts it sees are listed (one
//   is used; of several the person picks); the project is found, or made when
//   there is none; one that deploys from git, or holds a site Studio did not
//   publish, is left alone and the person asked for another name; the site
//   goes up once, and its address is the project's own.
//
// What it found and did is the answer, step by step. Saving keeps what was
// found; a test leaves the setting as it was, though what it made (a first
// commit, Pages turned on, a project) stays made, and says so. The token
// goes to secret storage on a save and is never in an answer.

/** A Cloudflare API token's shape: printable, no spaces, of a plausible length. */
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/

export type ArtifactsSetupDeps = {
  store: ArtifactsSettingsStore
  hostDeps: ArtifactsHostDeps
  siteTemplate: () => Promise<ArtifactsSiteTemplate>
  /** A `file://` repository is accepted for GitHub Pages: the suite's stand-in for a host. */
  allowLocalRepositories?: boolean
}

type Failure = Extract<ArtifactsSetupResult, { ok: false }>

function fail(steps: ArtifactsCheck[], message: string, field?: ArtifactsSetupField): Failure {
  return { ok: false, steps, message, ...(field ? { field } : {}) }
}

/** The first change a host makes: the site's own files, so main exists and the gallery answers. */
async function putUpSite(
  host: ArtifactsHost,
  template: ArtifactsSiteTemplate,
  source: string,
): Promise<ReturnType<ArtifactsHost['change']>> {
  return host.change(async (root) => {
    await finishSiteTree(root, template, { repository: source, siteUrl: host.siteUrl() })
    return { message: 'Set up the artifacts site', value: true }
  })
}

async function setUpGitHub(
  input: Extract<ArtifactsSetupInput, { provider: 'github-pages' }>,
  save: boolean,
  deps: ArtifactsSetupDeps,
): Promise<ArtifactsSetupResult> {
  const steps: ArtifactsCheck[] = []
  const repositoryUrl = typeof input.repositoryUrl === 'string' ? input.repositoryUrl.trim() : ''
  const parsed = parseArtifactsRepositoryUrl(repositoryUrl)
  if (!parsed.ok) return fail(steps, parsed.message, 'github.repositoryUrl')
  const repository = parsed.repository
  if (repository.transport === 'file' && !deps.allowLocalRepositories) {
    return fail(
      steps,
      'GitHub Pages serves a repository on github.com or a GitHub Enterprise Server; give its address.',
      'github.repositoryUrl',
    )
  }
  if (!deps.hostDeps.ghApi)
    return fail(steps, 'GitHub Pages is set up through the GitHub CLI, which this build cannot reach.')

  const checks = await createGitStore({
    repository,
    checkoutRoot: join(deps.hostDeps.dataDir, 'repositories'),
    deps: deps.hostDeps,
  }).test()
  steps.push(...checks)
  const refused = checks.find((check) => check.status === 'fail')
  if (refused) return fail(steps, refused.detail, 'github.repositoryUrl')

  const saved = deps.store.read()
  const host = createGitHubPagesHost({
    repository,
    siteUrl: saved.github.repositoryUrl === repositoryUrl ? saved.github.siteUrl : '',
    deps: { ...deps.hostDeps, onSiteUrl: undefined },
  })
  const changed = await putUpSite(host, await deps.siteTemplate(), repositoryUrl)
  if (!changed.ok) {
    steps.push({ label: 'Site', status: 'fail', detail: changed.message })
    return fail(steps, changed.message)
  }
  if (changed.commit && changed.value) {
    steps.push({ label: 'Gallery', status: 'pass', detail: 'The gallery is on main.' })
  }
  steps.push(...changed.steps)
  const failed = changed.steps.find((step) => step.status === 'fail')
  if (failed) return fail(steps, failed.detail)

  const siteUrl = host.siteUrl()
  if (save) {
    const next: ArtifactsSettings = { ...saved, provider: 'github-pages', github: { repositoryUrl, siteUrl } }
    const kept = await keep(deps, next, undefined)
    if (kept) return fail(steps, kept)
  }
  return { ok: true, steps, siteUrl, saved: save, view: await deps.store.view() }
}

async function setUpCloudflare(
  input: Extract<ArtifactsSetupInput, { provider: 'cloudflare-pages' }>,
  save: boolean,
  deps: ArtifactsSetupDeps,
): Promise<ArtifactsSetupResult> {
  const steps: ArtifactsCheck[] = []
  const given = typeof input.token === 'string' ? input.token.trim() : ''
  if (given && !TOKEN_PATTERN.test(given)) {
    return fail(
      steps,
      'That does not look like a Cloudflare API token. Paste the token itself, as Cloudflare showed it.',
      'cloudflare.token',
    )
  }
  const token = given || (await deps.store.cloudflareToken())
  if (!token) return fail(steps, 'Paste an API token with the Cloudflare Pages Edit permission.', 'cloudflare.token')
  const saved = deps.store.read()

  const listed = await listCloudflareAccounts({
    token,
    ...(deps.hostDeps.fetch ? { fetch: deps.hostDeps.fetch } : {}),
    ...(deps.hostDeps.cloudflareApiBase ? { apiBase: deps.hostDeps.cloudflareApiBase } : {}),
  })
  if (!listed.ok) {
    steps.push({ label: 'API token', status: 'fail', detail: listed.message })
    return fail(steps, listed.message, 'cloudflare.token')
  }
  if (listed.accounts.length === 0) {
    const message =
      'This token can see no Cloudflare account, so there is nowhere to publish. Make a token with Account › Cloudflare Pages › Edit on the account to use (Create a token, on this page).'
    steps.push({ label: 'Account', status: 'fail', detail: message })
    return fail(steps, message, 'cloudflare.token')
  }
  const wanted = typeof input.accountId === 'string' ? input.accountId.trim().toLowerCase() : ''
  const account = wanted
    ? listed.accounts.find((entry) => entry.id === wanted)
    : (listed.accounts.find((entry) => entry.id === saved.cloudflare.accountId) ??
      (listed.accounts.length === 1 ? listed.accounts[0] : undefined))
  if (wanted && !account) {
    // A saved account a new token cannot see: offer the ones it can.
    return {
      ok: false,
      steps,
      field: 'cloudflare.accountId',
      message: 'The token cannot see that account. Pick one it can.',
      accounts: listed.accounts,
    }
  }
  if (!account) {
    return {
      ok: false,
      steps,
      field: 'cloudflare.accountId',
      message: `The token can see ${listed.accounts.length} accounts. Pick the one to publish to.`,
      accounts: listed.accounts,
    }
  }
  steps.push({ label: 'Account', status: 'pass', detail: `Found account ${account.name}.` })

  const sameAccount = saved.cloudflare.accountId === account.id
  const projectInput = typeof input.projectName === 'string' ? input.projectName.trim().toLowerCase() : undefined
  const projectName = projectInput !== undefined ? projectInput : sameAccount ? saved.cloudflare.projectName : ''
  const name = cloudflareProjectName({ projectName })
  if (!isCloudflareProjectName(name)) {
    return fail(
      steps,
      'A Pages project name is lowercase letters, digits and hyphens, at most 58 characters.',
      'cloudflare.projectName',
    )
  }
  const client = createCloudflarePagesClient({
    accountId: account.id,
    projectName: name,
    token: async () => token,
    ...(deps.hostDeps.fetch ? { fetch: deps.hostDeps.fetch } : {}),
    ...(deps.hostDeps.cloudflareApiBase ? { apiBase: deps.hostDeps.cloudflareApiBase } : {}),
  })
  const elsewhere =
    name === DEFAULT_CLOUDFLARE_PROJECT
      ? 'Give another project name under Advanced.'
      : 'Choose another project name under Advanced.'
  let found = await client.project()
  if (!found.ok && found.status === 404) {
    const made = await client.createProject()
    if (made.ok) {
      steps.push({ label: 'Project', status: 'pass', detail: `Created project ${name}.` })
      found = made
    } else if (made.status === 409 || /already exists/i.test(made.message)) {
      // Made a moment ago by someone else: read it as found, and check it below.
      found = await client.project()
    } else {
      steps.push({ label: 'Project', status: 'fail', detail: made.message })
      return fail(steps, made.message, 'cloudflare.projectName')
    }
  }
  if (!found.ok) {
    steps.push({ label: 'Project', status: 'fail', detail: found.message })
    return fail(
      steps,
      found.message,
      found.status === 401 || found.status === 403 ? 'cloudflare.token' : 'cloudflare.projectName',
    )
  }
  if (!steps.some((step) => step.label === 'Project')) {
    if (found.project.sourceType) {
      const message = `A Pages project named ${name} already exists and deploys from its own ${found.project.sourceType} connection, so it takes no upload from Studio. ${elsewhere}`
      steps.push({ label: 'Project', status: 'fail', detail: message })
      return fail(steps, message, 'cloudflare.projectName')
    }
    const latest = await client.latestDeployment()
    if (!latest.ok) {
      steps.push({ label: 'Project', status: 'fail', detail: latest.message })
      return fail(steps, latest.message)
    }
    if (latest.deployed && !latest.studios) {
      const message = `A Pages project named ${name} already holds a site Studio did not publish, which publishing would replace. ${elsewhere}`
      steps.push({ label: 'Project', status: 'fail', detail: message })
      return fail(steps, message, 'cloudflare.projectName')
    }
    steps.push({ label: 'Project', status: 'pass', detail: `Found project ${name}.` })
  }

  const repositoryUrl =
    typeof input.repositoryUrl === 'string'
      ? input.repositoryUrl.trim()
      : sameAccount
        ? saved.cloudflare.repositoryUrl
        : ''
  if (repositoryUrl) {
    const parsed = parseArtifactsRepositoryUrl(repositoryUrl)
    if (!parsed.ok) return fail(steps, parsed.message, 'cloudflare.repositoryUrl')
  }
  const siteUrl = cloudflareProjectSiteUrl(found.project, `https://${name}.pages.dev/`)
  const next: ArtifactsSettings = {
    ...saved,
    provider: 'cloudflare-pages',
    cloudflare: {
      accountId: account.id,
      accountName: account.name,
      projectName: name === DEFAULT_CLOUDFLARE_PROJECT ? '' : name,
      repositoryUrl,
      siteUrl,
    },
  }
  const host = createCloudflarePagesHost({ settings: next, deps: deps.hostDeps, token })
  const changed = await putUpSite(host, await deps.siteTemplate(), repositoryUrl || `Cloudflare Pages project ${name}`)
  if (!changed.ok) {
    steps.push({ label: 'Site', status: 'fail', detail: changed.message })
    return fail(steps, changed.message, repositoryUrl ? 'cloudflare.repositoryUrl' : undefined)
  }
  steps.push(...changed.steps)
  if (changed.notLive) return fail(steps, changed.notLive)
  steps.push({ label: 'Site', status: 'pass', detail: siteUrl })

  if (save) {
    const kept = await keep(deps, next, given || undefined)
    if (kept) return fail(steps, kept)
  }
  return { ok: true, steps, siteUrl, saved: save, view: await deps.store.view() }
}

async function keep(
  deps: ArtifactsSetupDeps,
  settings: ArtifactsSettings,
  token: string | undefined,
): Promise<string | null> {
  try {
    await deps.store.write(settings, token)
    return null
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : 'an error'
    return `The setting could not be saved (${code}). Try again.`
  }
}

/**
 * Set a host up, or test it (`save: false`): what was found and done, and on
 * a save, the setting as kept. Never throws; never answers with a token.
 */
export async function setUpArtifacts(
  input: ArtifactsSetupInput,
  options: { save: boolean },
  deps: ArtifactsSetupDeps,
): Promise<ArtifactsSetupResult> {
  try {
    if (input.provider === null) {
      if (options.save) {
        const kept = await keep(deps, { ...deps.store.read(), provider: null }, undefined)
        if (kept) return fail([], kept)
      }
      return { ok: true, steps: [], siteUrl: null, saved: options.save, view: await deps.store.view() }
    }
    if (input.provider === 'github-pages') return await setUpGitHub(input, options.save, deps)
    if (input.provider === 'cloudflare-pages') return await setUpCloudflare(input, options.save, deps)
    return fail([], 'Choose GitHub Pages or Cloudflare Pages.', 'provider')
  } catch (error) {
    return fail([], `Setting up artifacts failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
