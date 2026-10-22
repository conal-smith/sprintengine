import { app } from 'electron'
import { join } from 'path'

import { createArtifactPublishRoots, type ArtifactPublishRootsDeps } from './artifacts/artifact-publish-roots'
import { createElectronThumbnailer } from './artifacts/artifact-thumbnail-electron'
import { readArtifactsSiteTemplate, type ArtifactsSiteTemplate } from './artifacts/artifact-site'
import { settingsWithSiteUrl, type ArtifactsHostDeps } from './artifacts/artifacts-hosts'
import { createArtifactsService } from './artifacts/artifacts-service'
import { createArtifactsSettingsStore } from './artifacts/artifacts-settings-store'
import { setUpArtifacts } from './artifacts/artifacts-setup'
import { ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS } from './artifacts/artifacts-setup-consent'
import { createArtifactsSetupConsentBroker } from './artifacts/artifacts-setup-consent-broker'
import { askToSetUpArtifacts } from './artifacts/artifacts-setup-consent-electron'
import { createArtifactsTools } from './artifacts/artifacts-tools'
import { listCloudflareAccounts } from './artifacts/cloudflare-pages-client'
import type { GhApi } from './artifacts/github-pages'
import type { ArtifactsSetupInput, ArtifactsSetupResult } from '../shared/artifacts'
import { readStudioEnv } from '../shared/studio-env'
import { runGitCommand } from './git-run'
import { sharedGhRunner } from './github/gh'
import { createGhHostTokenResolver } from './github/host-token'
import type { GitHubTokenStore } from './github-token-store'
import { broadcastToWorkspaceWindows, listWorkspaceWindows } from './window-factory'
import { activeWorktreePool } from './worktree-pool/active-pool'

/**
 * The site's files as they ship: an extraResource in a packaged build
 * (package.json `build.extraResources`), the repository's own folder in a dev
 * build.
 */
function artifactsSiteDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'artifacts-site')
    : join(app.getAppPath(), 'resources', 'artifacts-site')
}

/** `gh api` on a host: GitHub Pages is read and turned on through it. */
const ghApi: GhApi = async (host, path, request) => {
  const args = ['api', '--hostname', host, path]
  if (request?.method && request.method !== 'GET') args.push('--method', request.method)
  for (const [key, value] of Object.entries(request?.fields ?? {})) args.push('-f', `${key}=${value}`)
  const answered = await sharedGhRunner().run(args, { timeoutMs: 30_000 })
  if (!answered.found) return { ok: false, status: null, message: 'gh is not installed', notInstalled: true }
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (answered.code === 0) return { ok: true, status: 200, json: parse(answered.stdout) }
  const status = /HTTP (\d{3})/.exec(answered.stderr)?.[1]
  // gh prints GitHub's own answer on stdout and its summary on stderr.
  const body = parse(answered.stdout) as { message?: unknown } | null
  return {
    ok: false,
    status: status ? Number(status) : null,
    message:
      typeof body?.message === 'string' ? body.message : (answered.stderr.trim().split('\n').pop() ?? 'gh failed'),
  }
}

/** What app-services.ts wires Settings ▸ Artifacts and the `artifacts.*` tools from. */
export function createArtifactsServices({
  githubTokenStore,
  findWorkspace,
}: {
  githubTokenStore: Pick<GitHubTokenStore, 'resolveToken'>
  /** The chat a publishing agent belongs to, for the folders it may publish from. */
  findWorkspace: ArtifactPublishRootsDeps['findWorkspace']
}) {
  const settingsStore = createArtifactsSettingsStore({ resolveUserDataDir: () => app.getPath('userData') })
  const ghHostToken = createGhHostTokenResolver(sharedGhRunner())
  // A stand-in for Cloudflare's API, for a build tried out against one; never set in use.
  const cloudflareApiBase = readStudioEnv('SPRINTENGINE_CLOUDFLARE_API_URL')?.trim() || undefined
  const hostDeps: ArtifactsHostDeps = {
    dataDir: join(app.getPath('userData'), 'artifacts'),
    git: (cwd, args, env, options) => runGitCommand(cwd, args, env, options),
    // The saved GitHub token goes to github.com only; any other host, a
    // company's GitHub included, signs in with the one gh holds for it.
    resolveHostToken: async (host) => {
      if (host === 'github.com') {
        const saved = await githubTokenStore.resolveToken().catch(() => '')
        if (saved) return saved
      }
      return ghHostToken(host)
    },
    cloudflareToken: () => settingsStore.cloudflareToken(),
    ghApi,
    ...(cloudflareApiBase ? { cloudflareApiBase } : {}),
    // The address the host answered, kept so the tools and the page show it.
    onSiteUrl: (kind, url) => settingsStore.update((current) => settingsWithSiteUrl(current, kind, url)),
  }
  let template: Promise<ArtifactsSiteTemplate> | null = null
  // Read once; a read that failed (the folder missing from a broken install)
  // is tried again next time rather than kept.
  const siteTemplate = () => {
    template ??= readArtifactsSiteTemplate(artifactsSiteDir()).catch((error: unknown) => {
      template = null
      throw error
    })
    return template
  }
  const service = createArtifactsService({
    settings: () => settingsStore.read(),
    hostDeps,
    siteTemplate,
    thumbnailer: createElectronThumbnailer(),
    git: (cwd, args) => runGitCommand(cwd, args),
  })
  const setUp = (input: ArtifactsSetupInput, save: boolean): Promise<ArtifactsSetupResult> =>
    setUpArtifacts(input, { save }, { store: settingsStore, hostDeps, siteTemplate })
  // The person is asked in the Studio window they are looking at, natively
  // when no window is showing.
  const consent = createArtifactsSetupConsentBroker({
    broadcast: broadcastToWorkspaceWindows,
    hasWindow: () => listWorkspaceWindows().some((window) => window.isVisible() && !window.isMinimized()),
    fallback: askToSetUpArtifacts,
    timeoutMs: ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS,
  })
  const artifactsTools = createArtifactsTools({
    service,
    publishRoots: createArtifactPublishRoots({
      findWorkspace,
      poolWorktrees: async () => {
        const pool = activeWorktreePool()
        return pool ? (await pool.snapshots()).flatMap((snapshot) => snapshot.slots) : []
      },
      appDirs: [hostDeps.dataDir],
    }),
    setup: {
      cloudflareAccount: async (token, accountId) => {
        const use = token || (await settingsStore.cloudflareToken())
        if (!use)
          return {
            ok: false,
            message: 'Ask the person for a Cloudflare API token with the Cloudflare Pages Edit permission.',
          }
        const listed = await listCloudflareAccounts({
          token: use,
          ...(cloudflareApiBase ? { apiBase: cloudflareApiBase } : {}),
        })
        if (!listed.ok) return { ok: false, message: listed.message }
        if (listed.accounts.length === 0) {
          return {
            ok: false,
            message:
              'The token can see no Cloudflare account; the person makes one with Cloudflare Pages Edit on an account.',
          }
        }
        const saved = settingsStore.read().cloudflare.accountId
        const chosen = accountId
          ? listed.accounts.find((account) => account.id === accountId.toLowerCase())
          : (listed.accounts.find((account) => account.id === saved) ??
            (listed.accounts.length === 1 ? listed.accounts[0] : undefined))
        if (chosen) return { ok: true, account: chosen }
        return accountId
          ? { ok: false, message: 'The token cannot see that account.' }
          : { ok: false, message: `The token can see ${listed.accounts.length} accounts.`, accounts: listed.accounts }
      },
      run: (input) => setUp(input, true),
      consent: consent.ask,
    },
  })

  return {
    artifactsSettingsStore: settingsStore,
    artifactsService: service,
    artifactsTools,
    setUpArtifacts: setUp,
    artifactsSetupConsent: consent,
  }
}
