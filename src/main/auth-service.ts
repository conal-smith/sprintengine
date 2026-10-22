import { app, safeStorage, shell } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { dirname, join } from 'path'
import type { SprintEngineAuthState, SessionSnapshot, SessionUser } from '../shared/electron-api'
import { AccountPhotoCache } from './account-photo-cache'
import { CURRENT_DEEP_LINK_SCHEME, DEEP_LINK_SCHEMES } from '../shared/deep-link-scheme'
import {
  CLERK_IDENTITY_PROVIDER,
  IDENTITY_MARKER_FILE_NAME,
  MULTIAUTH_IDENTITY_PROVIDER,
  REFRESH_TOKEN_FILE_NAMES,
  buildClerkAuthorizationUrl,
  buildMultiauthAuthorizationUrl,
  isIdentityProviderKind,
  parseClerkIdentityConfig,
  type IdentityConfig,
} from './desktop-identity'
import {
  SprintEngineAccountClient,
  parseAccountProfile,
  type AccountProfile,
  type IdentityMarker,
  type IdentityMarkerStore,
  type SecureRefreshTokenStore,
} from './account-client'
import { getErrorMessage } from './error-message'
import { safeStorageProtects } from './platform/safe-storage-protects'
import { DEFAULT_MULTIAUTH_BASE_URL } from './service-endpoints'
import { readStudioEnv } from '../shared/studio-env'
import { broadcastToAllWindows } from './window-broadcast'

// `MULTIAUTH_BASE_URL` names the studio's ACCOUNT SERVICE: where the account
// profile comes from. It is not, by definition, the identity
// provider: the service publishes which
// issuer a sign-in should go to at `/api/auth/identity` — itself on a
// self-hosted deployment, Clerk on the hosted one — and this bridge follows.
// The environment variable keeps its historical name so existing overrides
// (`MULTIAUTH_BASE_URL=http://localhost:3000` for local dev) keep working.
// The default it falls back to is set in `./service-endpoints`, where a build
// can bake in a different deployment via the same `MULTIAUTH_BASE_URL` name.
const MULTIAUTH_BASE_URL = (process.env['MULTIAUTH_BASE_URL'] || DEFAULT_MULTIAUTH_BASE_URL).replace(/\/+$/u, '')
const DESKTOP_CLIENT_ID = 'sprintengine-desktop' as const
const LOOPBACK_HOST = '127.0.0.1' as const
const LOOPBACK_PORT = 43110
const LOOPBACK_REDIRECT_URI = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/callback` as const
// What a custom-scheme sign-in asks the issuer to redirect to. Unlike the rest
// of the rename this half is not ours alone: a redirect_uri has to be on the
// issuer's registered list for the client or the authorization request is
// refused outright, so `SPRINTENGINE_AUTH_REDIRECT_MODE=custom` needs this
// spelling registered before it works. Loopback, the default, is unaffected.
const CUSTOM_SCHEME_REDIRECT_URI = `${CURRENT_DEEP_LINK_SCHEME}://auth/callback` as const
// Loopback for packaged builds too. The custom scheme is bound by
// macOS LaunchServices to whichever Electron bundle registered it last — a
// released build beside a beta is enough to send the callback to the wrong
// app — while RFC 8252 loopback has no such ambiguity. The custom scheme stays
// registered and reachable with `SPRINTENGINE_AUTH_REDIRECT_MODE=custom` for the
// one case loopback loses: the port being occupied.
const DEFAULT_AUTH_REDIRECT_MODE = 'loopback'
const CONFIGURED_AUTH_REDIRECT_MODE = readStudioEnv('SPRINTENGINE_AUTH_REDIRECT_MODE')
const AUTH_REDIRECT_MODE =
  CONFIGURED_AUTH_REDIRECT_MODE === 'custom' || CONFIGURED_AUTH_REDIRECT_MODE === 'loopback'
    ? CONFIGURED_AUTH_REDIRECT_MODE
    : DEFAULT_AUTH_REDIRECT_MODE
const REDIRECT_URI: typeof CUSTOM_SCHEME_REDIRECT_URI | typeof LOOPBACK_REDIRECT_URI =
  AUTH_REDIRECT_MODE === 'loopback' ? LOOPBACK_REDIRECT_URI : CUSTOM_SCHEME_REDIRECT_URI
// Names this app to the account service's sign-in page. It identifies the
// client; it does not ask for, or unlock, anything.
const PRODUCT_KEY = 'sprintengine' as const
// `relay:desktop` is still requested although nothing in the app talks to the
// hosted relay any more: the phone pairs over the tailnet (owner ruling
// 2026-09-27). The account service's relay authorization is kept for later
// use, and dropping the scope would change what every sign-in grants — a
// decision about that service, not a side effect of this app's cleanup.
// There is no `entitlements:read`: the app is open source with nothing behind
// a paywall (owner ruling 2026-09-27), so it never reads what an account is
// entitled to, and a sign-in does not ask for permission to.
const MULTIAUTH_DESKTOP_SCOPE = 'openid profile relay:desktop'
const AUTH_PREFLIGHT_TIMEOUT_MS = 3000
const ACCOUNT_SERVICE_LABEL = 'The SprintEngine account service'

type PendingDesktopLogin = {
  state: string
  nonce: string
  codeVerifier: string
  organizationId: string | null
  identity: IdentityConfig
  createdAt: number
}

type DesktopCallbackServer = {
  close(): Promise<void>
}

class ElectronSafeRefreshTokenStore implements SecureRefreshTokenStore {
  private inMemoryRefreshToken: string | null = null

  constructor(private readonly fileName: string) {}

  private get tokenPath(): string {
    return join(app.getPath('userData'), this.fileName)
  }

  async readRefreshToken(): Promise<string | null> {
    if (this.inMemoryRefreshToken) return this.inMemoryRefreshToken
    if (!safeStorageProtects(safeStorage)) return null

    try {
      const encrypted = await readFile(this.tokenPath)
      const refreshToken = safeStorage.decryptString(encrypted)
      this.inMemoryRefreshToken = refreshToken
      return refreshToken
    } catch {
      return null
    }
  }

  async writeRefreshToken(refreshToken: string): Promise<void> {
    this.inMemoryRefreshToken = refreshToken
    if (!safeStorageProtects(safeStorage)) return

    await mkdir(dirname(this.tokenPath), { recursive: true })
    await writeFile(this.tokenPath, safeStorage.encryptString(refreshToken), { mode: 0o600 })
  }

  async clearRefreshToken(): Promise<void> {
    this.inMemoryRefreshToken = null
    await unlink(this.tokenPath).catch(() => {})
  }
}

class ElectronIdentityMarkerStore implements IdentityMarkerStore {
  private get markerPath(): string {
    return join(app.getPath('userData'), IDENTITY_MARKER_FILE_NAME)
  }

  async read(): Promise<IdentityMarker | null> {
    try {
      const payload = JSON.parse(await readFile(this.markerPath, 'utf8')) as Partial<IdentityMarker>
      if (!isIdentityProviderKind(payload.provider)) return null
      const shared = {
        baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : undefined,
        organizationId:
          typeof payload.organizationId === 'string' && payload.organizationId.trim() ? payload.organizationId : null,
      }
      if (payload.provider === CLERK_IDENTITY_PROVIDER) {
        // Re-validated, not trusted: this file is plain JSON beside a
        // safeStorage-protected refresh token, and it names where that
        // token is POSTed on the next launch.
        const clerk = parseClerkIdentityConfig(payload.clerk)
        return clerk ? { provider: CLERK_IDENTITY_PROVIDER, clerk, ...shared } : null
      }
      return { provider: MULTIAUTH_IDENTITY_PROVIDER, ...shared }
    } catch {
      return null
    }
  }

  async write(marker: IdentityMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true })
    await writeFile(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async clear(): Promise<void> {
    await unlink(this.markerPath).catch(() => {})
  }
}

export class SprintEngineAuthBridge {
  private readonly client = new SprintEngineAccountClient({
    baseUrl: MULTIAUTH_BASE_URL,
    clientId: DESKTOP_CLIENT_ID,
    refreshTokenStores: {
      multiauth: new ElectronSafeRefreshTokenStore(REFRESH_TOKEN_FILE_NAMES.multiauth),
      clerk: new ElectronSafeRefreshTokenStore(REFRESH_TOKEN_FILE_NAMES.clerk),
    },
    identityMarker: new ElectronIdentityMarkerStore(),
    env: process.env,
    fetch,
    log: (event, data) => {
      if (event.includes('failed') || event.includes('invalid')) console.warn(`[auth] ${event}`, data ?? {})
      else console.info(`[auth] ${event}`, data ?? {})
    },
  })
  private state: SprintEngineAuthState = signedOutAuthState('Checking account.')
  private pendingLogin: PendingDesktopLogin | null = null
  private callbackServer: DesktopCallbackServer | null = null
  // The account profile (name, email, remote photo URL) from the last
  // successful fetch, so an offline boot shows who is signed in — and, through
  // the photo cache, their photo — rather than a blank badge.
  private cachedAccount: AccountProfile | null = null
  private photoRefreshInFlight: string | null = null
  private readonly photoCache = new AccountPhotoCache({
    cachePath: () => join(app.getPath('userData'), 'multiauth-account-photo.json'),
  })

  async initialize(): Promise<SprintEngineAuthState> {
    this.setState({ ...this.state, status: 'checking', message: 'Checking account.' })

    try {
      await this.client.resumeStoredSession()
    } catch {
      // No session could be resumed. An account cached by an earlier session
      // means one was signed in and the service is out of reach (logout
      // deletes the cache), so keep showing who it was; the next refresh
      // resumes the session from the token on disk once the service answers.
      const account = await this.readOfflineAccount()
      this.setState(
        account
          ? {
              ...account,
              authenticated: true,
              status: 'signed_in',
              message: `${ACCOUNT_SERVICE_LABEL} could not be reached. Showing your last sign-in.`,
            }
          : signedOutAuthState(null),
      )
      return this.state
    }

    return this.refreshAccount()
  }

  getState(): SprintEngineAuthState {
    return this.state
  }

  async login(organizationId?: string | null): Promise<{ state: string; authorizationUrl: string }> {
    await this.preflightAuthServer()
    const identity = await this.resolveIdentityForLogin()
    await this.closeCallbackServer()

    const state = randomBase64Url(24)
    const nonce = randomBase64Url(24)
    const codeVerifier = randomBase64Url(48)
    const codeChallenge = pkceChallenge(codeVerifier)
    const selectedOrganizationId = organizationId?.trim() || this.state.selectedOrganization?.id
    const request = {
      redirectUri: REDIRECT_URI,
      codeChallenge,
      state,
      nonce,
      organizationId: selectedOrganizationId ?? null,
    }
    const authorizationUrl =
      identity.provider === CLERK_IDENTITY_PROVIDER
        ? buildClerkAuthorizationUrl(request, identity)
        : buildMultiauthAuthorizationUrl(request, {
            baseUrl: MULTIAUTH_BASE_URL,
            clientId: DESKTOP_CLIENT_ID,
            product: PRODUCT_KEY,
            scope: MULTIAUTH_DESKTOP_SCOPE,
          })

    if (REDIRECT_URI === LOOPBACK_REDIRECT_URI) {
      try {
        this.callbackServer = await startDesktopCallbackServer(async (callbackUrl) => {
          await this.handleCallback(callbackUrl)
        })
      } catch (error) {
        const message = getErrorMessage(error)
        this.setState({ ...this.state, status: 'error', message })
        throw new Error(message)
      }
    }

    this.pendingLogin = {
      state,
      nonce,
      codeVerifier,
      organizationId: selectedOrganizationId ?? null,
      identity,
      createdAt: Date.now(),
    }
    try {
      await shell.openExternal(authorizationUrl)
    } catch (error) {
      this.pendingLogin = null
      await this.closeCallbackServer()
      const message = `Could not open sign-in: ${getErrorMessage(error)}`
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] login-open-failed', { authorizationUrl, message })
      throw new Error(message)
    }

    this.setState({ ...this.state, message: 'Complete sign-in in your browser.' })
    console.info('[auth] login-started', {
      provider: identity.provider,
      authorizationUrl,
      organizationId: selectedOrganizationId ?? null,
    })

    return { state, authorizationUrl }
  }

  async handleCallback(callbackUrl: string): Promise<SprintEngineAuthState> {
    const url = new URL(callbackUrl)
    if (!isSupportedAuthCallbackUrl(url)) {
      throw new Error('Unsupported sign-in callback URL.')
    }

    const state = url.searchParams.get('state')
    const pending = this.pendingLogin
    if (!state || !pending || pending.state !== state) {
      throw new Error('Desktop sign-in state did not match.')
    }

    // The issuer's refusal, carried back on the redirect. Only acted on for
    // the sign-in it belongs to — the state check above — so nothing that can
    // reach the loopback port cancels a pending sign-in with a bare `error=`.
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      this.pendingLogin = null
      const description = url.searchParams.get('error_description')
      throw new Error(description ? `${oauthError}: ${description}` : `Sign-in was refused: ${oauthError}`)
    }

    const code = url.searchParams.get('code')
    if (!code) {
      throw new Error('Desktop sign-in callback carried no authorization code.')
    }

    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.pendingLogin = null
      throw new Error('Desktop sign-in expired. Start sign-in again.')
    }

    await this.client.exchangeCode({
      identity: pending.identity,
      redirectUri: customSchemeRedirectUriFor(url) ?? LOOPBACK_REDIRECT_URI,
      code,
      codeVerifier: pending.codeVerifier,
    })
    this.pendingLogin = null
    if (customSchemeRedirectUriFor(url)) {
      // The callback came in over the OS rather than the loopback listener, so
      // the listener (if `beginLogin` opened one) has nothing left to answer.
      await this.closeCallbackServer()
    }
    if (pending.organizationId) {
      await this.client.selectOrganization(pending.organizationId)
    }

    return this.refreshAccount()
  }

  async logout(): Promise<{ loggedOut: true }> {
    const result = await this.client.logout()
    this.pendingLogin = null
    await this.closeCallbackServer()
    this.cachedAccount = null
    await unlink(this.accountCachePath).catch(() => {})
    await this.photoCache.clear()
    this.setState(signedOutAuthState(null))
    return result
  }

  async selectOrganization(organizationId: string): Promise<{ organizationId: string }> {
    const result = await this.client.selectOrganization(organizationId)
    await this.refreshAccount()
    return result
  }

  // Who is signed in, asked of the account service. Signing in unlocks
  // nothing — every feature works signed out — so this is identity only: the
  // name, address and photo the account surfaces show.
  async refreshAccount(): Promise<SprintEngineAuthState> {
    try {
      const account = await this.client.getProfile()
      this.cachedAccount = account
      await this.writeCachedAccount(account)
      // Publish with whatever the photo cache holds — the cached bytes, or
      // nothing — and fetch on the side. The avatar host is not the account
      // service: a blocked or stalled CDN must not hold the account state (or
      // the browser's "sign-in complete" page) for the fetch timeout.
      const photoUrl = await this.photoCache.resolve(account.user.avatarUrl, { allowNetwork: false })
      if (await this.photoCache.needsFetch(account.user.avatarUrl)) {
        this.refreshPhotoInBackground(account.user)
      }
      this.setState({
        authenticated: true,
        user: toSessionUser(account.user, photoUrl),
        selectedOrganization: account.selectedOrganization,
        status: 'signed_in',
        message: null,
      })
    } catch (error) {
      // The profile could not be read. With a live session (the token
      // refreshed; only the profile call failed) or an account cached by an
      // earlier one, the user is still signed in — say what went wrong and
      // keep the identity already known. Otherwise there is no session.
      const account = await this.readOfflineAccount()
      if (account || this.client.currentIdentity()) {
        this.setState({
          user: account?.user ?? null,
          selectedOrganization: account?.selectedOrganization ?? null,
          authenticated: true,
          status: 'signed_in',
          message: getErrorMessage(error),
        })
        return this.state
      }

      this.setState({
        ...signedOutAuthState(getErrorMessage(error)),
        status: this.state.authenticated ? 'error' : 'signed_out',
      })
    }

    return this.state
  }

  async getSession(): Promise<SessionSnapshot> {
    if (!this.state.authenticated || !this.state.user || !this.state.selectedOrganization) {
      return { authenticated: false, user: null, selectedOrganization: null }
    }

    return {
      authenticated: true,
      user: this.state.user,
      selectedOrganization: this.state.selectedOrganization,
    }
  }

  // Which issuer this sign-in goes to: the operator override if set, else
  // whatever the account service publishes. Discovery failure is explicit —
  // guessing an issuer would send the user to the wrong sign-in page — and
  // so is a malformed override, since the operator asked for something.
  private async resolveIdentityForLogin(): Promise<IdentityConfig> {
    try {
      return await this.client.resolveIdentityForLogin()
    } catch (error) {
      const message = `${ACCOUNT_SERVICE_LABEL} could not say which sign-in to use. ${getErrorMessage(error)}`
      this.pendingLogin = null
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] identity-discovery-failed', { message })
      throw new Error(message)
    }
  }

  private async preflightAuthServer(): Promise<void> {
    const healthUrl = `${MULTIAUTH_BASE_URL}/api/health`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), AUTH_PREFLIGHT_TIMEOUT_MS)
      const response = await fetch(healthUrl, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))

      if (!response.ok) {
        throw new Error(`Account service health returned ${response.status}.`)
      }
    } catch (error) {
      const message = `${ACCOUNT_SERVICE_LABEL} is not reachable at ${MULTIAUTH_BASE_URL}. ${getErrorMessage(error)}`
      this.pendingLogin = null
      this.setState({ ...this.state, status: 'error', message })
      console.error('[auth] login-preflight-failed', { healthUrl, message })
      throw new Error(message)
    }
  }

  private async closeCallbackServer(): Promise<void> {
    const server = this.callbackServer
    this.callbackServer = null
    await server?.close()
  }

  // Fetches (or refreshes) the photo and re-publishes the state with it once
  // it lands, if the same user is still signed in. One fetch per source URL
  // at a time; a failure leaves the published photo as it was.
  private refreshPhotoInBackground(user: AccountProfile['user']): void {
    const sourceUrl = user.avatarUrl
    if (!sourceUrl || this.photoRefreshInFlight === sourceUrl) return
    this.photoRefreshInFlight = sourceUrl
    void this.photoCache
      .resolve(sourceUrl)
      .then((photoUrl) => {
        const current = this.state.user
        if (
          !photoUrl ||
          !this.state.authenticated ||
          !current ||
          current.id !== user.id ||
          current.photoUrl === photoUrl
        ) {
          return
        }
        this.setState({ ...this.state, user: { ...current, photoUrl } })
      })
      .catch((error) => {
        console.warn('[auth] account-photo-refresh-failed', { message: getErrorMessage(error) })
      })
      .finally(() => {
        if (this.photoRefreshInFlight === sourceUrl) this.photoRefreshInFlight = null
      })
  }

  // The user and organization to publish when the server cannot be asked:
  // what is already on screen, else the cached profile (photo from the local
  // cache only — no network). Null when neither exists.
  private async readOfflineAccount(): Promise<Pick<SprintEngineAuthState, 'user' | 'selectedOrganization'> | null> {
    if (this.state.authenticated && this.state.user && this.state.selectedOrganization) {
      return { user: this.state.user, selectedOrganization: this.state.selectedOrganization }
    }

    const cached = this.cachedAccount ?? (await this.readCachedAccount())
    if (!cached) return null
    this.cachedAccount = cached
    const photoUrl = await this.photoCache.resolve(cached.user.avatarUrl, { allowNetwork: false })
    return { user: toSessionUser(cached.user, photoUrl), selectedOrganization: cached.selectedOrganization }
  }

  private get accountCachePath(): string {
    return join(app.getPath('userData'), 'multiauth-account-cache.json')
  }

  private async readCachedAccount(): Promise<AccountProfile | null> {
    try {
      return parseAccountProfile(JSON.parse(await readFile(this.accountCachePath, 'utf8')))
    } catch {
      return null
    }
  }

  private async writeCachedAccount(profile: AccountProfile): Promise<void> {
    try {
      await mkdir(dirname(this.accountCachePath), { recursive: true })
      await writeFile(this.accountCachePath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[auth] account-cache-write-failed', { message: getErrorMessage(error) })
    }
  }

  private setState(state: SprintEngineAuthState): void {
    this.state = state
    broadcastToAllWindows('auth:state-changed', state)
  }
}

async function startDesktopCallbackServer(
  onCallback: (callbackUrl: string) => Promise<void>,
): Promise<DesktopCallbackServer> {
  let closed = false
  const server = createServer((request, response) => {
    void (async () => {
      const callbackUrl = new URL(request.url ?? '/', LOOPBACK_REDIRECT_URI)

      if (request.method !== 'GET' || callbackUrl.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found.')
        return
      }

      try {
        await onCallback(callbackUrl.toString())
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(callbackSuccessHtml())
      } catch (error) {
        broadcastToAllWindows('auth:callback-error', getErrorMessage(error))
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(callbackErrorHtml(getErrorMessage(error)))
      } finally {
        void closeServer(server)
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch((error) => {
    throw new Error(
      `Could not start the sign-in callback listener on ${LOOPBACK_REDIRECT_URI}: ${getErrorMessage(error)}`,
    )
  })

  return {
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await closeServer(server)
    },
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

// Null for anything that is not one of the app's own schemes — loopback
// included — so callers can use it both as "which redirect_uri does this
// callback belong to" and as "did this arrive over the OS".
function customSchemeRedirectUriFor(url: URL): typeof CUSTOM_SCHEME_REDIRECT_URI | null {
  if (url.protocol === `${CURRENT_DEEP_LINK_SCHEME}:`) return CUSTOM_SCHEME_REDIRECT_URI
  return null
}

function isSupportedAuthCallbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' &&
      url.hostname === LOOPBACK_HOST &&
      url.port === String(LOOPBACK_PORT) &&
      url.pathname === '/callback') ||
    (customSchemeRedirectUriFor(url) !== null && url.hostname === 'auth' && url.pathname === '/callback')
  )
}

function callbackSuccessHtml(): string {
  return '<!doctype html><meta charset="utf-8"><title>SprintEngine sign-in complete</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in is complete. You can return to SprintEngine.</body>'
}

function callbackErrorHtml(message: string): string {
  const escaped = message.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  )
  return `<!doctype html><meta charset="utf-8"><title>SprintEngine sign-in failed</title><body style="font:14px system-ui,sans-serif;background:#101012;color:#f4f4f5;padding:32px">Sign-in failed: ${escaped}</body>`
}

function toSessionUser(user: AccountProfile['user'], photoUrl: string | null): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    photoUrl,
  }
}

function signedOutAuthState(message: string | null): SprintEngineAuthState {
  return {
    authenticated: false,
    user: null,
    selectedOrganization: null,
    status: 'signed_out',
    message,
  }
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url')
}

function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

// Picked out of the raw command line rather than parsed, because a
// second-instance relaunch hands over every argument the OS launched with and
// most of them are not URLs. Case-folded first: a scheme is case-insensitive
// and nothing guarantees which case the OS hands back.
function isAuthCallbackArg(arg: string): boolean {
  const lowered = arg.toLowerCase()
  return (
    DEEP_LINK_SCHEMES.some((scheme) => lowered.startsWith(`${scheme}://auth/callback`)) ||
    lowered.startsWith(LOOPBACK_REDIRECT_URI)
  )
}

export async function parseAuthCallbackFromArgv(auth: SprintEngineAuthBridge, argv: string[]): Promise<void> {
  const callbackUrl = argv.find(isAuthCallbackArg)
  if (!callbackUrl) return

  try {
    await auth.handleCallback(callbackUrl)
  } catch (error) {
    broadcastToAllWindows('auth:callback-error', getErrorMessage(error))
  }
}
