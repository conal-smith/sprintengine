import { app } from 'electron'
import { join } from 'path'

import { createElectronThumbnailer } from './artifacts/artifact-thumbnail-electron'
import { readArtifactsSiteTemplate, type ArtifactsSiteTemplate } from './artifacts/artifact-site'
import { resolveArtifactsHost, type ArtifactsHostDeps, type GhApi } from './artifacts/artifacts-hosts'
import { createArtifactsService } from './artifacts/artifacts-service'
import { createArtifactsSettingsStore } from './artifacts/artifacts-settings-store'
import { createArtifactsTools } from './artifacts/artifacts-tools'
import { validateArtifactsSettings, type ArtifactsTestResult } from '../shared/artifacts'
import { runGitCommand } from './git-run'
import { sharedGhRunner } from './github/gh'
import { createGhHostTokenResolver } from './github/host-token'
import type { GitHubTokenStore } from './github-token-store'

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

/** `gh api` on a host, for Settings' Test only. */
const ghApi: GhApi = async (host, path) => {
  const answered = await sharedGhRunner().run(['api', '--hostname', host, path], { timeoutMs: 20_000 })
  if (!answered.found) return { ok: false, status: null, message: 'the GitHub CLI (gh) is not installed' }
  if (answered.code === 0) {
    try {
      return { ok: true, json: JSON.parse(answered.stdout) as unknown }
    } catch {
      return { ok: false, status: null, message: 'gh answered something other than JSON' }
    }
  }
  const status = /HTTP (\d{3})/.exec(answered.stderr)?.[1]
  return {
    ok: false,
    status: status ? Number(status) : null,
    message: answered.stderr.trim().split('\n').pop() ?? 'gh failed',
  }
}

/** What app-services.ts wires Settings ▸ Artifacts and the `artifacts.*` tools from. */
export function createArtifactsServices({
  githubTokenStore,
}: {
  githubTokenStore: Pick<GitHubTokenStore, 'resolveToken'>
}) {
  const settingsStore = createArtifactsSettingsStore({ resolveUserDataDir: () => app.getPath('userData') })
  const ghHostToken = createGhHostTokenResolver(sharedGhRunner())
  const hostDeps = (cloudflareToken: () => Promise<string>): ArtifactsHostDeps => ({
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
    cloudflareToken,
    ghApi,
  })
  let template: Promise<ArtifactsSiteTemplate> | null = null
  const service = createArtifactsService({
    settings: () => settingsStore.read(),
    hostDeps: hostDeps(() => settingsStore.cloudflareToken()),
    // Read once; a read that failed (the folder missing from a broken
    // install) is tried again on the next publish rather than kept.
    siteTemplate: () => {
      template ??= readArtifactsSiteTemplate(artifactsSiteDir()).catch((error: unknown) => {
        template = null
        throw error
      })
      return template
    },
    thumbnailer: createElectronThumbnailer(),
    git: (cwd, args) => runGitCommand(cwd, args),
  })
  const artifactsTools = createArtifactsTools({ service })

  /**
   * Settings' Test, on what the page shows rather than what is saved: a
   * token typed but not saved is tried as it is, and none typed means the
   * saved one. Nothing is published.
   */
  async function testSettings(input: unknown, cloudflareToken?: string): Promise<ArtifactsTestResult> {
    const validated = validateArtifactsSettings(input)
    if (!validated.ok) return { ok: false, checks: [{ label: 'Settings', status: 'fail', detail: validated.message }] }
    const token = cloudflareToken?.trim()
    const resolved = resolveArtifactsHost(
      validated.settings,
      hostDeps(async () => token || (await settingsStore.cloudflareToken())),
    )
    if (!resolved.ok) {
      return {
        ok: false,
        checks: [{ label: 'Settings', status: 'fail', detail: 'Choose a host and fill in its fields first.' }],
      }
    }
    return resolved.host.test()
  }

  return {
    artifactsSettingsStore: settingsStore,
    artifactsService: service,
    artifactsTools,
    testArtifactsSettings: testSettings,
  }
}
