import { createHash, createHmac, randomBytes } from 'crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import { isRecord } from '../../../shared/records'
import { normalizeTailnetScopes, type TailnetScope } from '../../../shared/tailnet'
import { hashSecret, secretsMatch } from './secret-hash'
import { DEFAULT_PAIR_REQUEST_TTL_MS, displayText, type TailnetDeviceStore } from './tailnet-devices'

// OAuth 2.1 for the tailnet MCP endpoint: the authorization server's state.
//
// An MCP client that speaks OAuth (Claude Code, Codex, any client following
// the MCP authorization spec) is given the endpoint's URL and nothing else. It
// is told where to sign in by the 401 it gets, registers itself, and sends the
// person's browser to the sign-in page; the person approves it in the Studio
// window, never on that page (`tailnet-oauth-http.ts`). What this file keeps:
//
// - Nothing for a registration. Registering (RFC 7591) is open to anything on
//   the tailnet, so it must not be a way to fill this machine's disk: the
//   client id IS the registration — its name and redirect URIs, signed with a
//   key only this Studio holds — and the authorization request is checked
//   against what the id says. Nothing is stored until a person approves.
// - Grants. An approved client is a paired device (`tailnet-devices.ts`,
//   origin `oauth`), so it is listed, scoped, narrowed and revoked in
//   Settings → Remote like any other, and is held to the tailnet node that
//   redeemed its code by the same `verifyPeer`. The grant beside it holds
//   what OAuth adds: the resource the tokens are for, when the sign-in ends,
//   the refresh token, and the access tokens in use.
// - Codes and pending sign-ins, in memory only: each lives minutes, and one
//   that survived a restart would be answering a browser that has moved on.
//
// Every token is opaque and random, and only its SHA-256 is kept, as a device
// token's is. An access token lasts an hour and is renewed with the refresh
// token, which is replaced each time it is used. A sign-in lasts 30 days from
// its approval, however much it is used; then the client asks again. A
// refresh token presented a second time means two parties hold it, so the
// grant is revoked outright (and with it every live session), and the client
// signs in again. A code is spent the first time it is presented, whether or
// not that redemption succeeds, and one presented after it minted a grant
// revokes that grant, for the same reason.

export const TAILNET_OAUTH_FILENAME = 'tailnet-oauth.json'

/**
 * An hour. Long enough that a working client refreshes a handful of times a
 * day, short enough that a token lifted from a log stops working before most
 * people would notice it had gone. Revocation does not wait for it: a revoked
 * grant's access tokens stop at once, since each request looks the grant up.
 */
export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000

/**
 * How long a sign-in lasts: 30 days from the approval, fixed. Refreshing
 * renews the access token, never the sign-in, so a refresh token stolen and
 * kept fresh is still worth nothing after a month, and every client in use is
 * put in front of the person again once a month. A paired device token does
 * not lapse; an OAuth client is likelier to be set up once on a borrowed or
 * trial machine and forgotten, and signing in again is one approval.
 */
export const OAUTH_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** An authorization code is redeemed by the client the moment the browser lands on it. */
export const OAUTH_CODE_TTL_MS = 60 * 1000

/**
 * A pending sign-in outlives its prompt a while, so a page that is reloaded
 * after the prompt lapsed can still send the browser back to the client with
 * an answer rather than strand it on an error.
 */
export const OAUTH_PENDING_AUTHORIZATION_TTL_MS = DEFAULT_PAIR_REQUEST_TTL_MS + 10 * 60 * 1000
const MAX_PENDING_AUTHORIZATIONS = 32

/**
 * An approved sign-in whose browser never came back for its code leaves a
 * device with no grant. It is removed after this long: the approval's own
 * collect window, the code's life, and slack.
 */
const ORPHAN_DEVICE_TTL_MS = 15 * 60 * 1000

const MAX_REDIRECT_URIS = 5
const MAX_REDIRECT_URI_LENGTH = 512
const MAX_ACCESS_TOKENS_PER_GRANT = 4
const MAX_RETIRED_REFRESH_HASHES = 64

/**
 * How long the refresh token just replaced still answers, from the node the
 * grant is bound to: several processes sharing one client's token store
 * refresh at the same moment, and the loser would otherwise look like a thief
 * and sign everyone out. It answers with the very tokens the winner got
 * (held in memory for this minute only), so both end up holding the same
 * pair. From any other node, or after the minute, it is a replay.
 */
export const OAUTH_REFRESH_GRACE_MS = 60 * 1000
const CLIENT_ID_PREFIX = 'mcc_'
const DEFAULT_CLIENT_NAME = 'MCP client'

/** A client, as its signed client id describes it. */
export type OAuthClient = {
  clientId: string
  clientName: string
  redirectUris: string[]
}

export type OAuthError = { ok: false; error: string; description: string; status?: number }

/** A sign-in waiting on the person, keyed by the pair request it raised. */
export type OAuthPendingAuthorization = {
  requestId: string
  keyHash: string
  clientId: string
  clientName: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  issuer: string
  expiresAtMs: number
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  scopes: TailnetScope[]
}

export type OAuthAccessCheck =
  { ok: true; deviceId: string; resource: string; clientId: string } | { ok: false; reason: 'unknown' | 'expired' }

type StoredGrant = {
  deviceId: string
  clientId: string
  clientName: string
  resource: string
  createdAt: string
  /** Epoch ms the sign-in ends: 30 days after approval, never moved. */
  expiresAtMs: number
  refreshHash: string
  retiredRefreshHashes: string[]
  accessTokens: Array<{ hash: string; expiresAtMs: number }>
}

type CodeRecord = {
  deviceId: string
  clientId: string
  clientName: string
  redirectUri: string
  codeChallenge: string
  resource: string
  expiresAtMs: number
  /** Presented once already. A second presentation is a replay. */
  spent: boolean
}

export type TailnetOAuthStore = {
  /** Validate a self-registration (RFC 7591) and answer the client id that carries it. */
  registerClient(metadata: unknown): { ok: true; client: OAuthClient } | OAuthError
  /** The client a client id describes, if this Studio signed it. */
  clientFor(clientId: string): OAuthClient | null
  /** Remember a sign-in the person has been asked about. */
  beginAuthorization(pending: OAuthPendingAuthorization): void
  pendingAuthorization(requestId: string): OAuthPendingAuthorization | null
  endAuthorization(requestId: string): void
  /** An authorization code for an approved sign-in, bound to everything the token request must repeat. */
  issueCode(input: { pending: OAuthPendingAuthorization; deviceId: string }): string
  /** The token request for a code (RFC 6749 4.1.3, with PKCE): a grant and its first tokens. */
  redeemCode(input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
    resource: string | null
  }): { ok: true; deviceId: string; clientId: string; tokens: OAuthTokens } | OAuthError
  /** A refresh: the presented token is spent and a new pair issued. A spent one revokes the grant. */
  refresh(input: {
    refreshToken: string
    clientId: string
    resource: string | null
    /**
     * Whether the grant may be refreshed from the node asking, judged before
     * the token is spent: a refresh token presented from the wrong machine is
     * refused without rotating, so the client that holds it keeps working.
     */
    admit?: (deviceId: string) => OAuthError | null
  }): { ok: true; deviceId: string; tokens: OAuthTokens } | (OAuthError & { deviceId?: string })
  /** Which grant an access token is, if it is one and still good. */
  authenticateAccessToken(token: string): OAuthAccessCheck
  /** RFC 7009: a refresh token ends its grant; an access token ends itself. Unknown tokens are no error. */
  revokeToken(token: string): void
  /**
   * Forget every registration: a new signing key, so no client id issued so
   * far is accepted again and each client registers afresh before its next
   * sign-in. Clients already signed in keep their grants; revoke them one by
   * one.
   */
  resetRegistrations(): void
  /** When a device's sign-in ends, for an OAuth client's device with a grant. */
  grantExpiry(deviceId: string): number | null
  /** Drop expired grants and sign-ins never completed; called on a timer and before reads. */
  sweep(): void
  dispose(): void
}

export function createTailnetOAuthStore(options: {
  resolveUserDataDir: () => string
  devices: Pick<TailnetDeviceStore, 'listDevices' | 'revokeDevice' | 'onDeviceRevoked'>
  now?: () => number
  log?: (message: string) => void
}): TailnetOAuthStore {
  const now = options.now ?? (() => Date.now())
  const loaded = readStore(options.resolveUserDataDir(), options.log)
  let grants: StoredGrant[] = loaded.grants
  let onDisk = loaded.onDisk
  // The key client ids are signed with. Kept beside the grants (owner-only),
  // so a client registered before a restart is still known after one.
  let signingKey = loaded.signingKey
  const pending = new Map<string, OAuthPendingAuthorization>()
  const codes = new Map<string, CodeRecord>()
  // Per grant, the refresh token last replaced and what replaced it, for the
  // grace minute. Memory only: plaintext tokens never reach disk.
  const lastRefresh = new Map<string, { previousHash: string; tokens: OAuthTokens; issuedAtMs: number }>()
  // A grant whose device is gone is gone too. Read before anything trusts it:
  // a device revoked by an older build, or by hand, has no listener to say so.
  grants = grants.filter((grant) => options.devices.listDevices().some((device) => device.id === grant.deviceId))

  const unsubscribe = options.devices.onDeviceRevoked((deviceId) => {
    const before = grants.length
    grants = grants.filter((grant) => grant.deviceId !== deviceId)
    lastRefresh.delete(deviceId)
    for (const [hash, code] of codes) if (code.deviceId === deviceId) codes.delete(hash)
    if (grants.length !== before) safePersist()
  })

  function key(): Buffer {
    if (!signingKey) {
      signingKey = randomBytes(32)
      safePersist()
    }
    return signingKey
  }

  function sign(body: string): string {
    return createHmac('sha256', key()).update(`mcp-client-id.${body}`).digest('base64url')
  }

  function persist(): void {
    const path = join(options.resolveUserDataDir(), TAILNET_OAUTH_FILENAME)
    if (onDisk === 'unreadable') {
      options.log?.(
        `${TAILNET_OAUTH_FILENAME} could not be read, so it is not written over; this change lasts until quit.`,
      )
      return
    }
    if (onDisk === 'invalid') {
      try {
        renameSync(path, `${path}.invalid-${now()}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          onDisk = 'unreadable'
          return
        }
      }
      onDisk = 'readable'
    }
    const body = { version: 1, signingKey: signingKey?.toString('base64url') ?? null, grants }
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  function safePersist(): void {
    try {
      persist()
    } catch (error) {
      options.log?.(`${TAILNET_OAUTH_FILENAME} could not be written: ${message(error)}`)
    }
  }

  function revokeGrant(deviceId: string, why: string): void {
    options.log?.(`OAuth grant for device ${deviceId} revoked: ${why}`)
    lastRefresh.delete(deviceId)
    grants = grants.filter((grant) => grant.deviceId !== deviceId)
    // The device goes with it, which closes whatever it had open.
    options.devices.revokeDevice(deviceId)
    safePersist()
  }

  function mintTokens(grant: StoredGrant): OAuthTokens {
    const accessToken = `mcat_${randomBytes(32).toString('base64url')}`
    const refreshToken = `mcrt_${randomBytes(32).toString('base64url')}`
    const at = now()
    // Never past the sign-in's own end.
    const accessExpiresAtMs = Math.min(at + OAUTH_ACCESS_TOKEN_TTL_MS, grant.expiresAtMs)
    grant.refreshHash = hashSecret(refreshToken)
    grant.accessTokens = [
      ...grant.accessTokens.filter((token) => token.expiresAtMs > at),
      { hash: hashSecret(accessToken), expiresAtMs: accessExpiresAtMs },
    ].slice(-MAX_ACCESS_TOKENS_PER_GRANT)
    const device = options.devices.listDevices().find((entry) => entry.id === grant.deviceId)
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.max(0, Math.floor((accessExpiresAtMs - at) / 1000)),
      scopes: device?.scopes ?? [],
    }
  }

  function sweep(): void {
    const at = now()
    for (const [id, entry] of pending) if (entry.expiresAtMs <= at) pending.delete(id)
    for (const [hash, code] of codes) if (code.expiresAtMs <= at) codes.delete(hash)
    const lapsed = grants.filter((grant) => grant.expiresAtMs <= at)
    for (const grant of lapsed) revokeGrant(grant.deviceId, 'its 30 days are up')
    // An approved sign-in whose code was never redeemed: a device with nothing to serve it.
    const awaitingCode = new Set([...codes.values()].filter((code) => !code.spent).map((code) => code.deviceId))
    for (const device of options.devices.listDevices()) {
      if (device.origin.kind !== 'oauth') continue
      if (grants.some((grant) => grant.deviceId === device.id) || awaitingCode.has(device.id)) continue
      const createdAtMs = Date.parse(device.createdAt)
      if (Number.isFinite(createdAtMs) && createdAtMs + ORPHAN_DEVICE_TTL_MS > at) continue
      options.log?.(`OAuth device ${device.id} removed: its sign-in was approved but never completed.`)
      options.devices.revokeDevice(device.id)
    }
  }

  return {
    registerClient(metadata) {
      const read = readRegistration(metadata)
      if (!read.ok) return read
      const body = Buffer.from(JSON.stringify({ v: 1, n: read.clientName, r: read.redirectUris })).toString('base64url')
      const clientId = `${CLIENT_ID_PREFIX}${body}.${sign(body)}`
      return { ok: true, client: { clientId, clientName: read.clientName, redirectUris: read.redirectUris } }
    },

    clientFor(clientId) {
      if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null
      const [body, signature, extra] = clientId.slice(CLIENT_ID_PREFIX.length).split('.')
      if (!body || !signature || extra !== undefined) return null
      if (!secretsMatch(signature, sign(body))) return null
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      } catch {
        return null
      }
      if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.n !== 'string' || !Array.isArray(parsed.r)) return null
      const redirectUris = parsed.r.filter((uri): uri is string => typeof uri === 'string')
      return { clientId, clientName: parsed.n, redirectUris }
    },

    beginAuthorization(entry) {
      sweep()
      pending.set(entry.requestId, entry)
      while (pending.size > MAX_PENDING_AUTHORIZATIONS) pending.delete(pending.keys().next().value!)
    },

    pendingAuthorization(requestId) {
      const entry = pending.get(requestId)
      if (!entry) return null
      if (entry.expiresAtMs <= now()) {
        pending.delete(requestId)
        return null
      }
      return entry
    },

    endAuthorization(requestId) {
      pending.delete(requestId)
    },

    issueCode({ pending: entry, deviceId }) {
      const code = `mcac_${randomBytes(32).toString('base64url')}`
      codes.set(hashSecret(code), {
        deviceId,
        clientId: entry.clientId,
        clientName: entry.clientName,
        redirectUri: entry.redirectUri,
        codeChallenge: entry.codeChallenge,
        resource: entry.resource,
        expiresAtMs: now() + OAUTH_CODE_TTL_MS,
        spent: false,
      })
      return code
    },

    redeemCode(input) {
      sweep()
      const record = codes.get(hashSecret(input.code))
      if (!record) return invalidGrant('That authorization code is not valid, or has expired.')
      if (record.spent) {
        // Presented before: whoever holds it now is not, or not only, the
        // client it was issued to (RFC 6749 4.1.2). Whatever it minted goes.
        codes.delete(hashSecret(input.code))
        if (grants.some((grant) => grant.deviceId === record.deviceId))
          revokeGrant(record.deviceId, 'its authorization code was presented twice')
        return invalidGrant('That authorization code was already used. Sign in again.')
      }
      // Spent on presentation, whether or not what follows succeeds: a code
      // that could be tried again could be guessed at.
      record.spent = true
      if (record.expiresAtMs <= now()) return invalidGrant('That authorization code has expired. Sign in again.')
      if (input.clientId !== record.clientId)
        return invalidGrant('That authorization code was issued to a different client.')
      if (input.redirectUri !== record.redirectUri)
        return invalidGrant('redirect_uri does not match the one the code was issued for.')
      if (input.resource !== null && input.resource !== record.resource)
        return { ok: false, error: 'invalid_target', description: 'resource does not match the one signed in for.' }
      if (!pkceMatches(input.codeVerifier, record.codeChallenge))
        return invalidGrant('code_verifier does not match the code_challenge.')
      if (!options.devices.listDevices().some((device) => device.id === record.deviceId))
        return invalidGrant('The approval behind that code has been revoked.')
      const at = now()
      const grant: StoredGrant = {
        deviceId: record.deviceId,
        clientId: record.clientId,
        clientName: record.clientName,
        resource: record.resource,
        createdAt: new Date(at).toISOString(),
        expiresAtMs: at + OAUTH_GRANT_TTL_MS,
        refreshHash: '',
        retiredRefreshHashes: [],
        accessTokens: [],
      }
      grants = [...grants.filter((entry) => entry.deviceId !== record.deviceId), grant]
      const tokens = mintTokens(grant)
      // A write that fails leaves the grant live in memory for this run: the
      // tokens are already the client's, and refusing them now would only
      // make its next refresh look like a replay.
      safePersist()
      return { ok: true, deviceId: record.deviceId, clientId: record.clientId, tokens }
    },

    refresh(input) {
      sweep()
      const presented = hashSecret(input.refreshToken)
      const grant = grants.find((entry) => entry.refreshHash && secretsMatch(presented, entry.refreshHash))
      if (!grant) {
        const replayed = grants.find((entry) =>
          entry.retiredRefreshHashes.some((hash) => secretsMatch(presented, hash)),
        )
        const recent = replayed ? lastRefresh.get(replayed.deviceId) : undefined
        if (
          replayed &&
          recent &&
          secretsMatch(presented, recent.previousHash) &&
          now() - recent.issuedAtMs <= OAUTH_REFRESH_GRACE_MS &&
          input.clientId === replayed.clientId &&
          !input.admit?.(replayed.deviceId)
        ) {
          // The same client, from its own node, a moment late: the pair it
          // would have got is the one the other caller just did.
          const elapsedSeconds = Math.floor((now() - recent.issuedAtMs) / 1000)
          return {
            ok: true,
            deviceId: replayed.deviceId,
            tokens: {
              ...recent.tokens,
              expiresInSeconds: Math.max(0, recent.tokens.expiresInSeconds - elapsedSeconds),
            },
          }
        }
        if (replayed) {
          // Rotated away already: two parties hold this grant's refresh token.
          // Which one is the client cannot be told, so neither keeps it.
          revokeGrant(replayed.deviceId, 'a refresh token was presented after it had been replaced')
          return {
            ...invalidGrant('That refresh token was already used, so this sign-in has been revoked. Sign in again.'),
            deviceId: replayed.deviceId,
          }
        }
        return invalidGrant('That refresh token is not valid, or the sign-in has ended. Sign in again.')
      }
      if (input.clientId !== grant.clientId) return invalidGrant('That refresh token was issued to a different client.')
      if (input.resource !== null && input.resource !== grant.resource)
        return { ok: false, error: 'invalid_target', description: 'resource does not match the one signed in for.' }
      const refused = input.admit?.(grant.deviceId)
      if (refused) return refused
      const previousHash = grant.refreshHash
      grant.retiredRefreshHashes = [...grant.retiredRefreshHashes, previousHash].slice(-MAX_RETIRED_REFRESH_HASHES)
      const tokens = mintTokens(grant)
      lastRefresh.set(grant.deviceId, { previousHash, tokens, issuedAtMs: now() })
      safePersist()
      return { ok: true, deviceId: grant.deviceId, tokens }
    },

    authenticateAccessToken(token) {
      if (!token) return { ok: false, reason: 'unknown' }
      const presented = hashSecret(token)
      const at = now()
      for (const grant of grants) {
        const match = grant.accessTokens.find((entry) => secretsMatch(presented, entry.hash))
        if (!match) continue
        if (match.expiresAtMs <= at || grant.expiresAtMs <= at) return { ok: false, reason: 'expired' }
        return { ok: true, deviceId: grant.deviceId, resource: grant.resource, clientId: grant.clientId }
      }
      return { ok: false, reason: 'unknown' }
    },

    revokeToken(token) {
      if (!token) return
      const presented = hashSecret(token)
      const byRefresh = grants.find(
        (grant) =>
          (grant.refreshHash && secretsMatch(presented, grant.refreshHash)) ||
          grant.retiredRefreshHashes.some((hash) => secretsMatch(presented, hash)),
      )
      if (byRefresh) {
        revokeGrant(byRefresh.deviceId, 'the client revoked its refresh token')
        return
      }
      for (const grant of grants) {
        const before = grant.accessTokens.length
        grant.accessTokens = grant.accessTokens.filter((entry) => !secretsMatch(presented, entry.hash))
        if (grant.accessTokens.length !== before) {
          safePersist()
          return
        }
      }
    },

    resetRegistrations() {
      signingKey = randomBytes(32)
      persist()
    },

    grantExpiry: (deviceId) => grants.find((grant) => grant.deviceId === deviceId)?.expiresAtMs ?? null,

    sweep,

    dispose() {
      unsubscribe()
      pending.clear()
      codes.clear()
      lastRefresh.clear()
    },
  }
}

function invalidGrant(description: string): OAuthError {
  return { ok: false, error: 'invalid_grant', description }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) == challenge, and the verifier well formed. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER_SHAPE.test(verifier)) return false
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return secretsMatch(computed, challenge)
}

/** 43–128 unreserved characters (RFC 7636 4.1). */
const PKCE_VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/u
/** An S256 challenge is the base64url of 32 bytes: 43 characters, no padding. */
export const PKCE_S256_CHALLENGE_SHAPE = /^[A-Za-z0-9\-_]{43}$/u

/**
 * Read a self-registration (RFC 7591 2): its redirect URIs, which must all be
 * ones this server will send a browser to, and a name to show the person.
 * Everything else a client may send is accepted and not kept (RFC 7591 lets a
 * server ignore what it does not offer): every client is public, proves itself
 * with PKCE, and is answered with what it was registered as.
 */
export function readRegistration(
  value: unknown,
): { ok: true; clientName: string; redirectUris: string[] } | OAuthError {
  if (!isRecord(value)) return invalidClientMetadata('The registration must be a JSON object.')
  const uris = value.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0)
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris must list at least one URI.' }
  if (uris.length > MAX_REDIRECT_URIS)
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `At most ${MAX_REDIRECT_URIS} redirect URIs may be registered.`,
    }
  const redirectUris: string[] = []
  for (const uri of uris) {
    const checked = typeof uri === 'string' ? checkRedirectUri(uri) : null
    if (!checked)
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        description:
          'Every redirect URI must be http on a loopback address (localhost, 127.0.0.1 or [::1]), with no fragment. Studio is on your tailnet only, so it signs in clients running on a machine there.',
      }
    redirectUris.push(uri as string)
  }
  const grantTypes = value.grant_types
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) ||
      !grantTypes.every((type) => type === 'authorization_code' || type === 'refresh_token'))
  )
    return invalidClientMetadata('Only the authorization_code and refresh_token grants are offered.')
  const responseTypes = value.response_types
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.every((type) => type === 'code')))
    return invalidClientMetadata('Only the code response type is offered.')
  const name = displayText(value.client_name, 100)
  return { ok: true, clientName: name || DEFAULT_CLIENT_NAME, redirectUris }
}

function invalidClientMetadata(description: string): OAuthError {
  return { ok: false, error: 'invalid_client_metadata', description }
}

export type RedirectUriKind = { kind: 'loopback'; host: string }

/**
 * Whether a browser may be sent to `uri` with a code: http on a loopback
 * address (RFC 8252 7.3), which is where a client on the browser's own machine
 * listens. Nothing else — no https, no custom schemes, no fragment, no
 * credentials in the URL. Studio is reachable on the tailnet alone, so every
 * client that can use it runs on a machine there and signs in through a
 * loopback redirect (Claude Code and Codex both do); an https redirect would
 * only ever send a code to a web service, which could not reach Studio to use
 * it, and would make every sign-in link a way to send the browser anywhere.
 */
export function checkRedirectUri(uri: string): RedirectUriKind | null {
  if (uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.hash || uri.includes('#') || parsed.username || parsed.password) return null
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))
    return { kind: 'loopback', host: parsed.hostname }
  return null
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether the redirect URI an authorization request names is one the client
 * registered. Exact string match, except that a loopback URI matches on any
 * port (RFC 8252 7.3): a native client binds whatever port is free when it
 * signs in, and could not have known it when it registered.
 */
export function redirectUriRegistered(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true
  const asked = checkRedirectUri(requested)
  if (asked?.kind !== 'loopback') return false
  const askedUrl = new URL(requested)
  return registered.some((candidate) => {
    if (checkRedirectUri(candidate)?.kind !== 'loopback') return false
    const known = new URL(candidate)
    return (
      known.protocol === askedUrl.protocol &&
      known.hostname === askedUrl.hostname &&
      known.pathname === askedUrl.pathname &&
      known.search === askedUrl.search
    )
  })
}

/** The scopes a `scope` parameter names, in the vocabulary's order; ones outside it are not errors, just not granted. */
export function readScopeParameter(value: string | null): TailnetScope[] {
  if (!value) return []
  return normalizeTailnetScopes(value.split(/\s+/u).filter(Boolean))
}

function readStore(
  userDataDir: string,
  log?: (message: string) => void,
): { signingKey: Buffer | null; grants: StoredGrant[]; onDisk: 'readable' | 'unreadable' | 'invalid' } {
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, TAILNET_OAUTH_FILENAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { signingKey: null, grants: [], onDisk: 'readable' }
    log?.(`Could not read ${TAILNET_OAUTH_FILENAME}: ${message(error)}`)
    return { signingKey: null, grants: [], onDisk: 'unreadable' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const record = isRecord(parsed) ? parsed : {}
    const keyText = typeof record.signingKey === 'string' ? record.signingKey : ''
    const signingKey = keyText ? Buffer.from(keyText, 'base64url') : null
    const grants = Array.isArray(record.grants) ? record.grants.flatMap(readStoredGrant) : []
    return { signingKey: signingKey && signingKey.length >= 32 ? signingKey : null, grants, onDisk: 'readable' }
  } catch (error) {
    log?.(
      `${TAILNET_OAUTH_FILENAME} is not valid JSON (${message(error)}); no OAuth sign-in is trusted until it is fixed.`,
    )
    return { signingKey: null, grants: [], onDisk: 'invalid' }
  }
}

function readStoredGrant(value: unknown): StoredGrant[] {
  if (
    !isRecord(value) ||
    typeof value.deviceId !== 'string' ||
    typeof value.clientId !== 'string' ||
    typeof value.resource !== 'string' ||
    typeof value.refreshHash !== 'string' ||
    !value.refreshHash ||
    typeof value.expiresAtMs !== 'number'
  )
    return []
  const hashes = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0) : []
  return [
    {
      deviceId: value.deviceId,
      clientId: value.clientId,
      clientName: displayText(value.clientName, 100),
      resource: value.resource,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
      expiresAtMs: value.expiresAtMs,
      refreshHash: value.refreshHash,
      retiredRefreshHashes: hashes(value.retiredRefreshHashes).slice(-MAX_RETIRED_REFRESH_HASHES),
      accessTokens: Array.isArray(value.accessTokens)
        ? value.accessTokens.flatMap((entry) =>
            isRecord(entry) && typeof entry.hash === 'string' && typeof entry.expiresAtMs === 'number'
              ? [{ hash: entry.hash, expiresAtMs: entry.expiresAtMs }]
              : [],
          )
        : [],
    },
  ]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
