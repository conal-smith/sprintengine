/**
 * Settings ▸ Artifacts, owned by main: the `artifacts.*` tools run here and
 * read it on every call, with or without a window open.
 *
 * Two files under userData. `artifacts-settings.json` holds what is not
 * secret: which host, and each host's fields. The Cloudflare API token is
 * sealed apart in `artifacts-cloudflare-token.bin` with the app's secret
 * cipher (Electron's `safeStorage` in the desktop), as the GitHub token is
 * (github-token-store.ts). Without a cipher it lasts for the session only.
 * The token is never in a view, a log line or an error.
 *
 * An absent, unreadable or malformed settings file reads as nothing set up,
 * and the tools then refuse, naming the page, rather than publish somewhere
 * unasked.
 */
import { readFileSync } from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import {
  artifactsSiteUrl,
  derivedGitHubPagesUrl,
  EMPTY_ARTIFACTS_SETTINGS,
  validateArtifactsSettings,
  type ArtifactsSettings,
  type ArtifactsSettingsView,
  type ArtifactsSettingsWriteResult,
} from '../../shared/artifacts'
import { writeFileAtomicSync } from '../../server/platform/atomic-file'
import { studioPlatform } from '../../server/platform/platform'
import { openSecret, sealSecret, type SecretCipher } from '../../server/platform/secret-cipher'

const SETTINGS_FILE = 'artifacts-settings.json'
const TOKEN_FILE = 'artifacts-cloudflare-token.bin'

/** A Cloudflare API token's shape: printable, no spaces, of a plausible length. */
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{20,200}$/

export type ArtifactsSettingsStore = {
  /** The setting now. Never throws. */
  read(): ArtifactsSettings
  /** What the page shows. */
  view(): Promise<ArtifactsSettingsView>
  /** Validates and stores the non-secret fields. `cloudflareToken`, when present, replaces the token; `''` clears it. */
  write(input: unknown, cloudflareToken?: string): Promise<ArtifactsSettingsWriteResult>
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
      const parsed = validateArtifactsSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')))
      cached = parsed.ok ? parsed.settings : EMPTY_ARTIFACTS_SETTINGS
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

  async function view(): Promise<ArtifactsSettingsView> {
    const settings = read()
    return {
      ...settings,
      cloudflareToken: { configured: (await cloudflareToken()) !== '', encryptionAvailable: cipher().available() },
      siteUrl: artifactsSiteUrl(settings),
      derivedPagesUrl: derivedGitHubPagesUrl(settings),
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

  return {
    read,
    view,
    cloudflareToken,
    async write(input, token) {
      const result = validateArtifactsSettings(input)
      if (!result.ok) return result
      const nextToken = token === undefined ? undefined : token.trim()
      if (nextToken && !TOKEN_PATTERN.test(nextToken)) {
        return {
          ok: false,
          field: 'cloudflare.token',
          message: 'That does not look like a Cloudflare API token. Paste the token itself, as Cloudflare showed it.',
        }
      }
      if (result.settings.provider === 'cloudflare-pages' && nextToken === undefined && !(await cloudflareToken())) {
        return {
          ok: false,
          field: 'cloudflare.token',
          message: 'Enter an API token with Cloudflare Pages Edit permission.',
        }
      }
      if (result.settings.provider === 'cloudflare-pages' && nextToken === '') {
        return {
          ok: false,
          field: 'cloudflare.token',
          message: 'Cloudflare Pages needs an API token; choose another host to remove it.',
        }
      }
      try {
        if (nextToken !== undefined) await writeToken(nextToken)
        writeFileAtomicSync(settingsPath(), `${JSON.stringify(result.settings, null, 2)}\n`)
      } catch (error) {
        const reason =
          error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : 'an error'
        return { ok: false, field: 'provider', message: `The setting could not be saved (${reason}). Try again.` }
      }
      cached = result.settings
      return { ok: true, view: await view() }
    },
  }
}
