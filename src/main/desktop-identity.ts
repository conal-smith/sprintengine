// Which identity provider the desktop signs in against, and the wire shapes of
// each. Pure: no Electron, no network — `auth-service.ts` supplies both, and
// `desktop-identity.test.ts` pins the contracts here without either.
//
// The account service (`MULTIAUTH_BASE_URL`) is no longer the identity
// provider by definition. It holds the account profile, and it PUBLISHES which issuer a client should sign in against at
// `GET /api/auth/identity`: itself on a self-hosted deployment, Clerk on the hosted one. The desktop reads that document at
// sign-in and keeps a refresh token per provider so that flipping the issuer
// back — on the server or with `SPRINTENGINE_IDENTITY_PROVIDER` — signs in
// against the credential that provider issued (the dual-accept window).

import { isRecord } from '../shared/records'
import { readStudioEnv } from '../shared/studio-env'

export const MULTIAUTH_IDENTITY_PROVIDER = 'multiauth' as const
export const CLERK_IDENTITY_PROVIDER = 'clerk' as const

export type IdentityProviderKind = typeof MULTIAUTH_IDENTITY_PROVIDER | typeof CLERK_IDENTITY_PROVIDER

const IDENTITY_PROVIDER_KINDS: readonly IdentityProviderKind[] = [MULTIAUTH_IDENTITY_PROVIDER, CLERK_IDENTITY_PROVIDER]

type MultiauthIdentityConfig = {
  provider: typeof MULTIAUTH_IDENTITY_PROVIDER
}

// Everything the desktop needs to run RFC 6749 + PKCE against Clerk. The
// endpoints are absolute so the document, not the client, decides the issuer's
// paths; the client id is THIS client's Clerk OAuth application id, picked out
// of the discovery document by the Multiauth client name it registered under.
export type ClerkIdentityConfig = {
  provider: typeof CLERK_IDENTITY_PROVIDER
  issuer: string
  clientId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  scopes: readonly string[]
}

export type IdentityConfig = MultiauthIdentityConfig | ClerkIdentityConfig

// The scopes a Clerk sign-in asks for. `offline_access` is what makes Clerk
// issue a refresh token, and the refresh token is the credential the desktop
// actually keeps — Clerk's access tokens last a day and the app must survive
// longer than that offline. Multiauth-style scopes (`relay:desktop`) are NOT
// requested here: Clerk tokens carry none, and the account service derives
// them from the token's audience instead.
export const CLERK_DESKTOP_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access']

// The Clerk OAuth application's relative endpoints under its issuer, from the
// authorization-server metadata Clerk publishes at
// `/.well-known/oauth-authorization-server`. Used to derive endpoints when an
// environment override names only the issuer.
const CLERK_AUTHORIZE_PATH = '/oauth/authorize'
const CLERK_TOKEN_PATH = '/oauth/token'

// One safeStorage file per provider. Never the same name: a rollback inside the
// dual-accept window needs the other provider's refresh token still on disk.
export const REFRESH_TOKEN_FILE_NAMES: Readonly<Record<IdentityProviderKind, string>> = {
  multiauth: 'multiauth-refresh-token.bin',
  clerk: 'clerk-refresh-token.bin',
}

// Remembers which provider issued the credential the last sign-in installed,
// so `initialize()` tries that store first. A preference, not an authority:
// the other store is still tried when this one has nothing usable.
export const IDENTITY_MARKER_FILE_NAME = 'desktop-identity.json'

export class IdentityDiscoveryError extends Error {
  override readonly name = 'IdentityDiscoveryError'
}

function readHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IdentityDiscoveryError(`Identity discovery is missing "${field}".`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new IdentityDiscoveryError(`Identity discovery "${field}" is not a URL: ${value}`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new IdentityDiscoveryError(`Identity discovery "${field}" must be https: ${value}`)
  }
  return url.toString().replace(/\/+$/u, '')
}

// Turns the account service's discovery document into this client's identity
// config. Throws on anything malformed rather than guessing a provider: a
// client that "falls back" to the wrong issuer sends its user to the wrong
// sign-in page, and the failure should be loud.
export function parseIdentityDiscovery(payload: unknown, clientName: string): IdentityConfig {
  if (!isRecord(payload)) {
    throw new IdentityDiscoveryError('Identity discovery returned no document.')
  }

  const schemaVersion = payload['schemaVersion']
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    throw new IdentityDiscoveryError(
      `Identity discovery schema ${String(schemaVersion)} is not understood by this build.`,
    )
  }

  const provider = payload['provider']
  if (provider === MULTIAUTH_IDENTITY_PROVIDER) {
    return { provider: MULTIAUTH_IDENTITY_PROVIDER }
  }

  if (provider !== CLERK_IDENTITY_PROVIDER) {
    throw new IdentityDiscoveryError(`Identity discovery names an unknown provider: ${String(provider)}`)
  }

  const issuer = readHttpsUrl(payload['issuer'], 'issuer')
  const authorizationEndpoint = readHttpsUrl(
    payload['authorizationEndpoint'] ?? `${issuer}${CLERK_AUTHORIZE_PATH}`,
    'authorizationEndpoint',
  )
  const tokenEndpoint = readHttpsUrl(payload['tokenEndpoint'] ?? `${issuer}${CLERK_TOKEN_PATH}`, 'tokenEndpoint')

  const clientIds = payload['clientIds']
  if (!isRecord(clientIds)) {
    throw new IdentityDiscoveryError('Identity discovery is missing "clientIds".')
  }
  const clientId = clientIds[clientName]
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw new IdentityDiscoveryError(`Identity discovery has no Clerk client id for "${clientName}".`)
  }

  const scopes =
    Array.isArray(payload['scopes']) && payload['scopes'].every((scope) => typeof scope === 'string')
      ? (payload['scopes'] as string[])
      : CLERK_DESKTOP_SCOPES
  // The desktop keeps the refresh token; without offline_access there is
  // none, and the browser sign-in would succeed only for the exchange to fail.
  if (!scopes.includes('offline_access')) {
    throw new IdentityDiscoveryError('Identity discovery scopes do not include offline_access.')
  }

  return {
    provider: CLERK_IDENTITY_PROVIDER,
    issuer,
    clientId: clientId.trim(),
    authorizationEndpoint,
    tokenEndpoint,
    scopes,
  }
}

// The Clerk issuers Studio's own account service signs in against. A stored
// marker naming any other is not trusted (`parseClerkIdentityConfig`).
const STUDIO_CLERK_ISSUER_ORIGINS: ReadonlySet<string> = new Set([
  'https://clerk.sprintengine.ai',
  'https://famous-anteater-45.clerk.accounts.dev',
])

/**
 * Whether a stored marker may name `issuer`: one of Studio's own, or the one
 * the operator pinned with `SPRINTENGINE_CLERK_ISSUER` (a self-hosted account
 * service). Any other is ignored, and a session that had one resumes through
 * the account service's discovery document, which says where to refresh.
 */
function isTrustedClerkIssuer(issuer: string, env: IdentityEnvironment = process.env): boolean {
  let origin: string
  try {
    const url = new URL(issuer)
    if (url.protocol !== 'https:') return false
    origin = url.origin
  } catch {
    return false
  }
  if (STUDIO_CLERK_ISSUER_ORIGINS.has(origin)) return true
  const pinned = readStudioEnv('SPRINTENGINE_CLERK_ISSUER', env)?.trim()
  if (!pinned) return false
  try {
    return new URL(pinned).origin === origin
  } catch {
    return false
  }
}

// `process.env` or any subset of it; only the three SPRINTENGINE_* keys are read.
// A stored Clerk config (the `desktop-identity.json` marker) re-validated
// before it is trusted. The marker is plain JSON beside a safeStorage-protected
// refresh token, so it must not be the weakest link: the issuer is one Studio
// knows (`isTrustedClerkIssuer`), every endpoint is https, and the token
// endpoint sits on the issuer's own origin — otherwise a tampered file could
// name where the refresh token gets POSTed next launch.
export function parseClerkIdentityConfig(
  value: unknown,
  env: IdentityEnvironment = process.env,
): ClerkIdentityConfig | null {
  if (!isRecord(value) || value['provider'] !== CLERK_IDENTITY_PROVIDER) return null

  try {
    const issuer = readHttpsUrl(value['issuer'], 'issuer')
    const authorizationEndpoint = readHttpsUrl(value['authorizationEndpoint'], 'authorizationEndpoint')
    const tokenEndpoint = readHttpsUrl(value['tokenEndpoint'], 'tokenEndpoint')
    const clientId = value['clientId']
    const scopes = value['scopes']

    if (!isTrustedClerkIssuer(issuer, env)) return null
    if (typeof clientId !== 'string' || !clientId.trim()) return null
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return null
    if (new URL(tokenEndpoint).origin !== new URL(issuer).origin) return null
    if (new URL(authorizationEndpoint).origin !== new URL(issuer).origin) return null

    return {
      provider: CLERK_IDENTITY_PROVIDER,
      issuer,
      clientId: clientId.trim(),
      authorizationEndpoint,
      tokenEndpoint,
      scopes: scopes as string[],
    }
  } catch {
    return null
  }
}

export type IdentityEnvironment = Record<string, string | undefined>

// The operator override. `SPRINTENGINE_IDENTITY_PROVIDER=multiauth` pins the
// desktop to Multiauth identity whatever the server publishes — the rollback
// lever inside the dual-accept window. `=clerk` pins it to Clerk and needs the
// issuer and client id alongside, since discovery is being bypassed. Unset
// means "ask the account service".
export function resolveIdentityOverride(env: IdentityEnvironment): IdentityConfig | null {
  const provider = readStudioEnv('SPRINTENGINE_IDENTITY_PROVIDER', env)?.trim()
  if (!provider) return null

  if (provider === MULTIAUTH_IDENTITY_PROVIDER) {
    return { provider: MULTIAUTH_IDENTITY_PROVIDER }
  }

  if (provider !== CLERK_IDENTITY_PROVIDER) {
    throw new IdentityDiscoveryError(
      `SPRINTENGINE_IDENTITY_PROVIDER must be "multiauth" or "clerk", not "${provider}".`,
    )
  }

  const issuer = readHttpsUrl(readStudioEnv('SPRINTENGINE_CLERK_ISSUER', env), 'SPRINTENGINE_CLERK_ISSUER')
  const clientId = readStudioEnv('SPRINTENGINE_CLERK_CLIENT_ID', env)?.trim()
  if (!clientId) {
    throw new IdentityDiscoveryError('SPRINTENGINE_IDENTITY_PROVIDER=clerk needs SPRINTENGINE_CLERK_CLIENT_ID.')
  }

  return {
    provider: CLERK_IDENTITY_PROVIDER,
    issuer,
    clientId,
    authorizationEndpoint: `${issuer}${CLERK_AUTHORIZE_PATH}`,
    tokenEndpoint: `${issuer}${CLERK_TOKEN_PATH}`,
    scopes: CLERK_DESKTOP_SCOPES,
  }
}

export type AuthorizationRequest = {
  redirectUri: string
  codeChallenge: string
  state: string
  nonce: string
  organizationId: string | null
}

export type MultiauthAuthorizationOptions = {
  baseUrl: string
  clientId: string
  product: string
  scope: string
}

// Multiauth's own sign-in page takes the PKCE parameters on its root URL with
// `returnTo=desktop`; unchanged from before the migration.
export function buildMultiauthAuthorizationUrl(
  request: AuthorizationRequest,
  options: MultiauthAuthorizationOptions,
): string {
  const search = new URLSearchParams({
    returnTo: 'desktop',
    product: options.product,
    client_id: options.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    state: request.state,
    nonce: request.nonce,
    scope: options.scope,
  })
  if (request.organizationId) {
    search.set('organization_id', request.organizationId)
  }
  return `${options.baseUrl}/?${search.toString()}`
}

// Standard RFC 6749 authorization request against Clerk's `/oauth/authorize`.
// No `organization_id`: organisation choice is a studio concept answered by
// the account service, not a Clerk one.
export function buildClerkAuthorizationUrl(request: AuthorizationRequest, config: ClerkIdentityConfig): string {
  const search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: request.redirectUri,
    scope: config.scopes.join(' '),
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${config.authorizationEndpoint}?${search.toString()}`
}

export type TokenSet = {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
}

// Clerk's token endpoint speaks form encoding and snake_case; Multiauth's
// speaks JSON and camelCase. Both normalise to one `TokenSet` here.
export function buildClerkCodeExchangeBody(input: {
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  })
}

export function buildClerkRefreshBody(input: { clientId: string; refreshToken: string }): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  })
}

export class TokenResponseError extends Error {
  override readonly name = 'TokenResponseError'
}

// A refresh grant may or may not rotate the refresh token; when the response
// omits one, the caller keeps the credential it already holds
// (`previousRefreshToken`). A code exchange has nothing to fall back to and
// must be issued one — `offline_access` was requested for exactly that.
export function parseClerkTokenResponse(payload: unknown, previousRefreshToken: string | null = null): TokenSet {
  if (!isRecord(payload)) {
    throw new TokenResponseError('Clerk token response was not an object.')
  }
  const accessToken = payload['access_token']
  const expiresIn = payload['expires_in']
  const refreshToken = payload['refresh_token'] ?? previousRefreshToken
  const tokenType = payload['token_type']

  if (typeof accessToken !== 'string' || !accessToken) {
    throw new TokenResponseError('Clerk token response has no access_token.')
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new TokenResponseError('Clerk token response has no refresh_token; was offline_access granted?')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new TokenResponseError('Clerk token response has no usable expires_in.')
  }
  if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
    throw new TokenResponseError(`Clerk token response has an unsupported token_type: ${tokenType}`)
  }

  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn }
}

export function parseMultiauthTokenResponse(payload: unknown): TokenSet {
  if (!isRecord(payload)) {
    throw new TokenResponseError('Account service token response was not an object.')
  }
  const accessToken = payload['accessToken']
  const refreshToken = payload['refreshToken']
  const expiresIn = payload['expiresIn']

  if (typeof accessToken !== 'string' || !accessToken) {
    throw new TokenResponseError('Account service token response has no accessToken.')
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new TokenResponseError('Account service token response has no refreshToken.')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new TokenResponseError('Account service token response has no usable expiresIn.')
  }

  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn }
}

// OAuth error bodies are `{ error, error_description }`; Multiauth's are
// `{ error: { message } }`. One reader for both so a failed exchange surfaces
// the server's own words whichever issuer answered.
export function readTokenErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  const error = payload['error']
  if (isRecord(error)) {
    const message = error['message']
    return typeof message === 'string' && message.trim() ? message : fallback
  }
  const description = payload['error_description']
  if (typeof description === 'string' && description.trim()) {
    return typeof error === 'string' && error.trim() ? `${error}: ${description}` : description
  }
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

export function isIdentityProviderKind(value: unknown): value is IdentityProviderKind {
  return typeof value === 'string' && (IDENTITY_PROVIDER_KINDS as readonly string[]).includes(value)
}

// The order `initialize()` tries the refresh-token stores in: the provider the
// last sign-in used first, then whatever else is on disk. Under an operator
// override only that provider is tried — a pinned desktop must not silently
// resume the other issuer's session.
export function refreshProviderOrder(
  marker: IdentityProviderKind | null,
  override: IdentityConfig | null,
): IdentityProviderKind[] {
  if (override) return [override.provider]
  const preferred = marker ?? MULTIAUTH_IDENTITY_PROVIDER
  return [preferred, ...IDENTITY_PROVIDER_KINDS.filter((kind) => kind !== preferred)]
}
