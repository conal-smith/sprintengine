/**
 * Settings ▸ Artifacts, owned by main: the `artifacts.*` tools run here and
 * read it on every call, with or without a window open.
 *
 * Two files under userData. `artifacts-settings.json` holds what is not
 * secret: which host, the repository, and what Studio found when it set the
 * host up (the site's address, the Cloudflare account and project). The
 * Cloudflare API token is sealed apart in `artifacts-cloudflare-token.bin`
 * with the app's secret cipher (Electron's `safeStorage` in the desktop), as
 * the GitHub token is (github-token-store.ts). Without a cipher it lasts for
 * the session only. The token is never in a view, a log line or an error.
 *
 * Nothing here decides what may be saved: `setUpArtifacts` (artifacts-setup.ts)
 * checks the host first and writes what it found. A file that cannot be read
 * reads as no host, and the tools then refuse rather than publish somewhere
 * unasked.
 */
import { mkdirSync, readFileSync } from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import {
  artifactsSiteUrl,
  EMPTY_ARTIFACTS_SETTINGS,
  readArtifactsSettings,
  type ArtifactsSettings,
  type ArtifactsSettingsView,
} from '../../shared/artifacts'
import { writeFileAtomicSync } from '../../server/platform/atomic-file'
import { studioPlatform } from '../../server/platform/platform'
import { openSecret, sealSecret, type SecretCipher } from '../../server/platform/secret-cipher'

const SETTINGS_FILE = 'artifacts-settings.json'
const TOKEN_FILE = 'artifacts-cloudflare-token.bin'

export type ArtifactsSettingsStore = {
  /** The setting now. Never throws. */
  read(): ArtifactsSettings
  /** What the page shows. */
  view(): Promise<ArtifactsSettingsView>
  /**
   * Keep the setting, and the Cloudflare token when one is given (`''`
   * clears it). Throws when the disk refuses; the caller says so.
   */
  write(settings: ArtifactsSettings, cloudflareToken?: string): Promise<void>
  /** Record what Studio found later (the site's address once Pages answers). Best effort. */
  update(change: (current: ArtifactsSettings) => ArtifactsSettings): void
  /** The Cloudflare token, or '' when none is held. Only for the call that needs it. */
  cloudflareToken(): Promise<string>
}

export type ArtifactsSettingsStoreDeps = {
  resolveUserDataDir: () => string
  /** The installed platform's cipher by default. */
  cipher?: SecretCipher
}

export function createArtifactsSettingsStore(deps: ArtifactsSettingsStoreDeps): ArtifactsSettingsStore {
  let cached: ArtifactsSettings | null = null
  let sessionToken: string | null = null
  const settingsPath = () => join(deps.resolveUserDataDir(), SETTINGS_FILE)
  const tokenPath = () => join(deps.resolveUserDataDir(), TOKEN_FILE)
  const cipher = () => deps.cipher ?? studioPlatform().secrets

  function read(): ArtifactsSettings {
    if (cached) return cached
    try {
      cached = readArtifactsSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')))
    } catch {
      cached = EMPTY_ARTIFACTS_SETTINGS
    }
    return cached
  }

  async function cloudflareToken(): Promise<string> {
    if (sessionToken !== null) return sessionToken
    if (!cipher().available()) return ''
    try {
      const token = (await openSecret(cipher(), await readFile(tokenPath()))).trim()
      sessionToken = token
      return token
    } catch {
      return ''
    }
  }

  async function writeToken(token: string): Promise<void> {
    if (!token) {
      sessionToken = ''
      if (cipher().available()) await unlink(tokenPath()).catch(() => {})
      return
    }
    sessionToken = token
    if (!cipher().available()) return
    await mkdir(dirname(tokenPath()), { recursive: true })
    await writeFile(tokenPath(), await sealSecret(cipher(), token), { mode: 0o600 })
  }

  function persist(settings: ArtifactsSettings): void {
    const clean = readArtifactsSettings(settings)
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileAtomicSync(settingsPath(), `${JSON.stringify(clean, null, 2)}\n`)
    cached = clean
  }

  return {
    read,
    cloudflareToken,
    async view() {
      const settings = read()
      return {
        ...settings,
        cloudflareToken: { configured: (await cloudflareToken()) !== '', encryptionAvailable: cipher().available() },
        siteUrl: artifactsSiteUrl(settings),
      }
    },
    async write(settings, token) {
      if (token !== undefined) await writeToken(token.trim())
      persist(settings)
    },
    update(change) {
      try {
        persist(change(read()))
      } catch {
        // Found again the next time it is needed.
      }
    },
  }
}
