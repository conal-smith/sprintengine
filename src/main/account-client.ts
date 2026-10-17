import type { SessionOrganization } from '../shared/electron-api'
import {
  CLERK_IDENTITY_PROVIDER,
  IdentityDiscoveryError,
  MULTIAUTH_IDENTITY_PROVIDER,
  buildClerkCodeExchangeBody,
  buildClerkRefreshBody,
  parseClerkTokenResponse,
  parseIdentityDiscovery,
  parseMultiauthTokenResponse,
  readTokenErrorMessage,
  refreshProviderOrder,
  resolveIdentityOverride,
  type ClerkIdentityConfig,
  type IdentityConfig,
  type IdentityEnvironment,
  type IdentityProviderKind,
  type TokenSet,
} from './desktop-identity'
import { getErrorMessage } from './error-message'

// The desktop's client for the studio's ACCOUNT SERVICE (`MULTIAUTH_BASE_URL`):
// the account profile and — through whichever identity provider the service
// names — sign-in, refresh and sign-out.
// Everything Electron (safeStorage files, the marker file, the browser
// window) is injected, so `account-client.test.ts` drives every path below
// with an in-process fetch: offline resume, the pinned-provider rollback,
// sign-out with the server unreachable, and an access token after a failed
// launch.

export type SecureRefreshTokenStore = {
  readRefreshToken(): Promise<string | null>
  writeRefreshToken(refreshToken: string): Promise<void>
  clearRefreshToken(): Promise<void>
}

// What the last sign-in used, persisted beside the refresh tokens. Carries the
// Clerk endpoints so a refresh on the next launch needs no discovery round
// trip — an offline launch must still resume the session from disk.
export type IdentityMarker = {
  provider: IdentityProviderKind
  clerk?: ClerkIdentityConfig
  /** The account service this session was signed in against; a marker from another is not this one's. */
  baseUrl?: string
  /** The organisation the desktop had selected, restored on resume (a Clerk token names none). */
  organizationId?: string | null
}

export type IdentityMarkerStore = {
  read(): Promise<IdentityMarker | null>
  write(marker: IdentityMarker): Promise<void>
  clear(): Promise<void>
}

// What `/api/auth/me` hands back: the account behind the desktop's bearer
// token. `avatarUrl` is the provider's remote photo URL; it is
// resolved through `AccountPhotoCache` before the renderer ever sees it.
export type AccountProfile = {
  user: {
    id: string
    email: string | null
    displayName: string | null
    avatarUrl: string | null
  }
  selectedOrganization: SessionOrganization
}

export type AccountClientLogger = (event: string, data?: Record<string, unknown>) => void

export type AccountClientOptions = {
  baseUrl: string
  clientId: string
  refreshTokenStores: Readonly<Record<IdentityProviderKind, SecureRefreshTokenStore>>
  identityMarker: IdentityMarkerStore
  env: IdentityEnvironment
  fetch: typeof fetch
  now?: () => number
  log?: AccountClientLogger
  discoveryTimeoutMs?: number
  /** How long a token or account-service request may take, its body included. */
  requestTimeoutMs?: number
}

// A Clerk token carries no studio organisation; the account service reads
// the selected one from this header. Ignored for Multiauth tokens.
export const ORGANIZATION_HEADER = 'x-multiauth-organization'
const IDENTITY_DISCOVERY_PATH = '/api/auth/identity'
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3000
// A refresh and a resume are shared by every caller that asks for the account
// while one is in flight, so a request that never finishes holds all of them:
// the account badge read "Checking account" until the platform's own fetch
// gave up minutes later. Generous for a token round trip on a slow link.
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000

export class SprintEngineAccountClient {
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private selectedOrganizationId: string | null = null
  // The provider that issued the credential this session runs on, and the
  // config needed to refresh it. Null until a session is installed.
  private identity: IdentityConfig | null = null
  // One refresh at a time: Multiauth rotates refresh tokens and treats a
  // reuse as replay, so two overlapping refreshes would revoke the session.
  private refreshInFlight: { provider: IdentityProviderKind; promise: Promise<TokenSet> } | null = null
  private resumeInFlight: Promise<TokenSet> | null = null
  // Bumped by every sign-out and every sign-in. A token round trip that
  // started under an earlier generation must not install its result: a
  // sign-out during a refresh would otherwise be undone by the refresh
  // landing — and under Clerk there is no server-side revocation to save it.
  private sessionGeneration = 0

  private readonly baseUrl: string
  private readonly clientId: string
  private readonly refreshTokenStores: Readonly<Record<IdentityProviderKind, SecureRefreshTokenStore>>
  private readonly identityMarker: IdentityMarkerStore
  private readonly env: IdentityEnvironment
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly log: AccountClientLogger
  private readonly discoveryTimeoutMs: number
  private readonly requestTimeoutMs: number

  constructor(options: AccountClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.clientId = options.clientId
    this.refreshTokenStores = options.refreshTokenStores
    this.identityMarker = options.identityMarker
    this.env = options.env
    this.fetchImpl = options.fetch
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  currentIdentity(): IdentityConfig | null {
    return this.identity
  }

  selectedOrganization(): string | null {
    return this.selectedOrganizationId
  }

  // The operator override, if any. A malformed one is a configuration
  // mistake worth surfacing, not worth refusing to resume a session over.
  identityOverride(): IdentityConfig | null {
    try {
      return resolveIdentityOverride(this.env)
    } catch (error) {
      this.log('identity-override-invalid', { message: getErrorMessage(error) })
      return null
    }
  }

  // Which issuer a NEW sign-in goes to: the operator override if set, else
  // whatever the account service publishes. Throws `IdentityDiscoveryError`
  // rather than guessing — a guess sends the user to the wrong sign-in page.
  async resolveIdentityForLogin(): Promise<IdentityConfig> {
    const override = resolveIdentityOverride(this.env)
    if (override) return override
    return this.discoverIdentity()
  }

  async discoverIdentity(): Promise<IdentityConfig> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.discoveryTimeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${IDENTITY_DISCOVERY_PATH}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (error) {
      throw new IdentityDiscoveryError(`Identity discovery failed: ${getErrorMessage(error)}`)
    } finally {
      clearTimeout(timeout)
    }

    // An account service from before discovery existed is a Multiauth one.
    if (response.status === 404) {
      return { provider: MULTIAUTH_IDENTITY_PROVIDER }
    }
    if (!response.ok) {
      throw new IdentityDiscoveryError(`Identity discovery returned ${response.status}.`)
    }

    return parseIdentityDiscovery(await response.json().catch(() => null), this.clientId)
  }

  async exchangeCode(input: {
    identity: IdentityConfig
    redirectUri: string
    code: string
    codeVerifier: string
  }): Promise<TokenSet> {
    const tokenSet =
      input.identity.provider === CLERK_IDENTITY_PROVIDER
        ? await this.exchangeClerkCode(input.identity, input)
        : await this.exchangeMultiauthCode(input)

    // A completed sign-in supersedes whatever was in flight: a resume that
    // lands after this must not put the previous session back.
    this.sessionGeneration += 1
    await this.installSession(input.identity, tokenSet, this.sessionGeneration)
    return tokenSet
  }

  // Refresh under a specific provider — the one whose store holds a token.
  // Under Clerk the endpoints come from the marker written at sign-in, so
  // this works with no network beyond the token endpoint itself.
  async refresh(identity: IdentityConfig): Promise<TokenSet> {
    // Share an in-flight refresh of the same provider; wait out one of the
    // other provider rather than racing two token families.
    while (this.refreshInFlight && this.refreshInFlight.provider !== identity.provider) {
      await this.refreshInFlight.promise.catch(() => {})
    }
    if (this.refreshInFlight) return this.refreshInFlight.promise

    const generation = this.sessionGeneration
    const promise = (async () => {
      const refreshToken = await this.refreshTokenStores[identity.provider].readRefreshToken()
      if (!refreshToken) {
        throw new Error(`No desktop refresh token is available for ${identity.provider}.`)
      }

      const tokenSet =
        identity.provider === CLERK_IDENTITY_PROVIDER
          ? await this.refreshClerk(identity, refreshToken)
          : await this.refreshMultiauth(refreshToken)

      await this.installSession(identity, tokenSet, generation)
      return tokenSet
    })()
    this.refreshInFlight = { provider: identity.provider, promise }
    promise
      .finally(() => {
        if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null
      })
      .catch(() => {})

    return promise
  }

  // Resume whatever session is on disk: the provider the last sign-in used
  // first, then the other. Under an operator override only that provider is
  // tried, so a pinned desktop never silently resumes the other issuer's
  // session — which is what makes `SPRINTENGINE_IDENTITY_PROVIDER=multiauth`
  // after a Clerk sign-in resume the RETAINED Multiauth token (the rollback).
  resumeStoredSession(): Promise<TokenSet> {
    if (this.resumeInFlight) return this.resumeInFlight

    this.resumeInFlight = (async () => {
      const override = this.identityOverride()
      const stored = await this.identityMarker.read()
      // A marker written against a different account service describes a
      // session this one never issued: a desktop re-pointed at a self-hosted
      // instance must not push its hosted Clerk token there, nor the reverse.
      const marker = stored && stored.baseUrl && stored.baseUrl !== this.baseUrl ? null : stored
      if (stored && !marker) {
        this.log('identity-marker-foreign-base-url', { markerBaseUrl: stored.baseUrl, baseUrl: this.baseUrl })
      }
      if (marker?.organizationId && !this.selectedOrganizationId) {
        this.selectedOrganizationId = marker.organizationId
      }
      const failures: Record<string, string> = {}

      for (const provider of refreshProviderOrder(marker?.provider ?? null, override)) {
        const identity = await this.identityForResume(provider, override, marker)
        if (!identity) {
          failures[provider] = 'no stored identity'
          continue
        }

        try {
          const tokenSet = await this.refresh(identity)
          this.log('identity-resumed', { provider, pinned: override !== null })
          return tokenSet
        } catch (error) {
          failures[provider] = getErrorMessage(error)
        }
      }

      this.log('identity-resume-failed', failures)
      throw new Error(
        Object.entries(failures)
          .map(([provider, reason]) => `${provider}: ${reason}`)
          .join('; ') || 'No desktop session is stored.',
      )
    })().finally(() => {
      this.resumeInFlight = null
    })

    return this.resumeInFlight
  }

  async logout(): Promise<{ loggedOut: true }> {
    // Multiauth revokes its session server-side — for whatever Multiauth
    // refresh token is on disk, not only the live session's, so a token
    // retained through a Clerk period is not left valid for 30 days. Clerk
    // publishes no revocation endpoint for public OAuth clients, so a Clerk
    // sign-out is the local clear alone. Either way the local clear is
    // unconditional: sign-out is the recovery path from a bad base URL and
    // must never depend on the server answering.
    // Clear first, then tell the server: nothing that lands after this point
    // (a refresh in flight, the revoke answer) can put the session back.
    const multiauthRefreshToken = await this.refreshTokenStores.multiauth.readRefreshToken()
    await this.clearSession()

    if (multiauthRefreshToken) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.discoveryTimeoutMs)
      await this.request<{ loggedOut: true }>(
        '/api/auth/logout',
        {
          method: 'POST',
          body: JSON.stringify({ refreshToken: multiauthRefreshToken }),
          signal: controller.signal,
        },
        { bearer: false },
      )
        .catch((error) => {
          this.log('server-logout-failed-local-session-cleared', { message: getErrorMessage(error) })
        })
        .finally(() => clearTimeout(timeout))
    }

    return { loggedOut: true }
  }

  async selectOrganization(organizationId: string): Promise<{ organizationId: string }> {
    if (!organizationId.trim()) {
      throw new Error('organizationId is required.')
    }

    this.selectedOrganizationId = organizationId
    if (this.identity) {
      await this.identityMarker.write(this.markerFor(this.identity))
    }
    return { organizationId }
  }

  async getProfile(): Promise<AccountProfile> {
    await this.ensureFreshAccessToken()
    const payload = await this.request<unknown>('/api/auth/me', { method: 'GET' })
    const profile = parseAccountProfile(payload)
    if (!profile) {
      throw new Error('The account service returned an unreadable account profile.')
    }
    return profile
  }

  // A usable bearer, refreshing when stale — and resuming from disk when no
  // session is live yet (a launch that could not reach the provider still
  // has a perfectly good refresh token on disk once the network is back).
  async getAccessToken(): Promise<string> {
    await this.ensureFreshAccessToken()
    if (!this.accessToken) {
      throw new Error('No desktop access token is available.')
    }
    return this.accessToken
  }

  private async ensureFreshAccessToken(): Promise<void> {
    if (!this.identity) {
      await this.resumeStoredSession()
      return
    }
    if (!this.accessToken || this.accessTokenExpiresAt <= this.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      await this.refresh(this.identity)
    }
  }

  private async identityForResume(
    provider: IdentityProviderKind,
    override: IdentityConfig | null,
    marker: IdentityMarker | null,
  ): Promise<IdentityConfig | null> {
    if (override?.provider === provider) return override
    if (provider === MULTIAUTH_IDENTITY_PROVIDER) return { provider: MULTIAUTH_IDENTITY_PROVIDER }
    if (marker?.clerk) return marker.clerk

    // A Clerk refresh token with no marker (lost or unreadable) is not a
    // dead session: if a token is there and the service is reachable, its
    // discovery document says where to refresh.
    if (!(await this.refreshTokenStores.clerk.readRefreshToken())) return null
    try {
      const discovered = await this.discoverIdentity()
      return discovered.provider === CLERK_IDENTITY_PROVIDER ? discovered : null
    } catch (error) {
      this.log('identity-marker-missing-discovery-failed', { message: getErrorMessage(error) })
      return null
    }
  }

  private async exchangeMultiauthCode(input: {
    redirectUri: string
    code: string
    codeVerifier: string
  }): Promise<TokenSet> {
    const payload = await this.request<unknown>(
      '/api/auth/desktop/exchange',
      {
        method: 'POST',
        body: JSON.stringify({
          clientId: this.clientId,
          redirectUri: input.redirectUri,
          code: input.code,
          codeVerifier: input.codeVerifier,
        }),
      },
      { bearer: false },
    )
    return parseMultiauthTokenResponse(payload)
  }

  private async refreshMultiauth(refreshToken: string): Promise<TokenSet> {
    const payload = await this.request<unknown>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ clientId: this.clientId, refreshToken }),
      },
      { bearer: false },
    )
    return parseMultiauthTokenResponse(payload)
  }

  private async exchangeClerkCode(
    identity: ClerkIdentityConfig,
    input: { redirectUri: string; code: string; codeVerifier: string },
  ): Promise<TokenSet> {
    const payload = await this.requestClerkToken(
      identity,
      buildClerkCodeExchangeBody({
        clientId: identity.clientId,
        redirectUri: input.redirectUri,
        code: input.code,
        codeVerifier: input.codeVerifier,
      }),
    )
    return parseClerkTokenResponse(payload)
  }

  private async refreshClerk(identity: ClerkIdentityConfig, refreshToken: string): Promise<TokenSet> {
    const payload = await this.requestClerkToken(
      identity,
      buildClerkRefreshBody({
        clientId: identity.clientId,
        refreshToken,
      }),
    )
    return parseClerkTokenResponse(payload, refreshToken)
  }

  private async requestClerkToken(identity: ClerkIdentityConfig, body: URLSearchParams): Promise<unknown> {
    const { response, payload } = await this.fetchJson(identity.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new Error(readTokenErrorMessage(payload, `Clerk token request failed (${response.status}).`))
    }

    return payload
  }

  // Every account-service call. The bearer is whichever provider's access
  // token the session holds — the service accepts both while the dual-accept
  // window is open — and the selected organisation rides along on
  // every bearer call, so the account service answers for the organisation
  // the desktop has selected.
  private async request<T>(path: string, init: RequestInit, options: { bearer?: boolean } = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    if ((options.bearer ?? true) && this.accessToken) {
      headers.set('authorization', `Bearer ${this.accessToken}`)
      if (this.selectedOrganizationId) {
        headers.set(ORGANIZATION_HEADER, this.selectedOrganizationId)
      }
    }

    const { response, payload } = await this.fetchJson(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      throw new Error(readTokenErrorMessage(payload, 'Account service request failed.'))
    }

    return payload as T
  }

  // One request and its JSON body under `requestTimeoutMs`, and under the
  // caller's own signal when it passes one. The deadline covers the body too:
  // a response whose headers arrive and whose body never ends stalls in
  // `json()`, not in `fetch`. A body that is not JSON reads as `{}`, as before;
  // one the deadline cut off is an error, never an empty answer.
  private async fetchJson(url: string, init: RequestInit): Promise<{ response: Response; payload: unknown }> {
    const deadline = new AbortController()
    const seconds = Math.round(this.requestTimeoutMs / 1000)
    const expired = new Promise<never>((_, reject) => {
      deadline.signal.addEventListener(
        'abort',
        () => reject(new Error(`${new URL(url).host} did not answer within ${seconds} s.`)),
        { once: true },
      )
    })
    // Settled only by the deadline, which may fire after both reads are done.
    expired.catch(() => undefined)
    const timer = setTimeout(() => deadline.abort(), this.requestTimeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal
    try {
      const response = await Promise.race([this.fetchImpl(url, { ...init, signal }), expired])
      const payload = (await Promise.race([response.json().catch(() => ({})), expired])) as unknown
      return { response, payload }
    } finally {
      clearTimeout(timer)
    }
  }

  private async installSession(identity: IdentityConfig, tokenSet: TokenSet, generation: number): Promise<void> {
    if (generation !== this.sessionGeneration) {
      throw new Error('The desktop session changed while a token request was in flight.')
    }
    this.identity = identity
    this.accessToken = tokenSet.accessToken
    this.accessTokenExpiresAt = this.now() + Math.max(0, tokenSet.expiresIn - 30) * 1000
    await this.refreshTokenStores[identity.provider].writeRefreshToken(tokenSet.refreshToken)
    await this.identityMarker.write(this.markerFor(identity))
  }

  private markerFor(identity: IdentityConfig): IdentityMarker {
    return {
      provider: identity.provider,
      ...(identity.provider === CLERK_IDENTITY_PROVIDER ? { clerk: identity } : {}),
      baseUrl: this.baseUrl,
      organizationId: this.selectedOrganizationId,
    }
  }

  private async clearSession(): Promise<void> {
    this.sessionGeneration += 1
    this.identity = null
    this.selectedOrganizationId = null
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    // Sign-out means signed out of the account, not of one issuer: both
    // credentials go. (Rollback inside the dual-accept window relies on the
    // OTHER token surviving a provider flip, not surviving a sign-out.)
    await Promise.all(Object.values(this.refreshTokenStores).map((store) => store.clearRefreshToken()))
    await this.identityMarker.clear()
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function parseAccountProfile(payload: unknown): AccountProfile | null {
  if (!payload || typeof payload !== 'object') return null
  const { user, selectedOrganization } = payload as { user?: unknown; selectedOrganization?: unknown }
  if (!user || typeof user !== 'object' || !selectedOrganization || typeof selectedOrganization !== 'object')
    return null
  const u = user as Record<string, unknown>
  const o = selectedOrganization as Record<string, unknown>
  if (typeof u.id !== 'string' || !u.id || typeof o.id !== 'string' || !o.id) return null
  const type = o.type === 'personal' || o.type === 'team' || o.type === 'enterprise' ? o.type : 'team'
  return {
    user: {
      id: u.id,
      email: optionalString(u.email),
      displayName: optionalString(u.displayName),
      avatarUrl: optionalString(u.avatarUrl),
    },
    selectedOrganization: {
      id: o.id,
      name: optionalString(o.name) ?? o.id,
      slug: optionalString(o.slug) ?? o.id,
      type,
    },
  }
}
