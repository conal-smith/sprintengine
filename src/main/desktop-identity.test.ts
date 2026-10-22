/**
 * The desktop's identity provider is what the account service
 * publishes, the operator override wins, and both issuers' wire shapes
 * normalise to one token set. No Electron, no network: `auth-service.ts`
 * supplies those and only routes through what is pinned here.
 */
import assert from 'node:assert/strict'
import {
  CLERK_DESKTOP_SCOPES,
  IdentityDiscoveryError,
  REFRESH_TOKEN_FILE_NAMES,
  TokenResponseError,
  buildClerkAuthorizationUrl,
  buildClerkCodeExchangeBody,
  buildClerkRefreshBody,
  buildMultiauthAuthorizationUrl,
  parseClerkIdentityConfig,
  parseClerkTokenResponse,
  parseIdentityDiscovery,
  parseMultiauthTokenResponse,
  readTokenErrorMessage,
  refreshProviderOrder,
  resolveIdentityOverride,
  type ClerkIdentityConfig,
} from './desktop-identity'
import { test } from 'vitest'

test('desktop-identity', async () => {
  const CLERK_DISCOVERY = {
    provider: 'clerk',
    issuer: 'https://clerk.sprintengine.ai/',
    authorizationEndpoint: 'https://clerk.sprintengine.ai/oauth/authorize',
    tokenEndpoint: 'https://clerk.sprintengine.ai/oauth/token',
    clientIds: { 'sprintengine-desktop': 'client_desk', 'sprintengine-mobile': 'client_mob' },
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    schemaVersion: 1,
  }

  function discoveryParsesClerkAndMultiauth(): void {
    const clerk = parseIdentityDiscovery(CLERK_DISCOVERY, 'sprintengine-desktop')
    assert.deepEqual(clerk, {
      provider: 'clerk',
      issuer: 'https://clerk.sprintengine.ai',
      clientId: 'client_desk',
      authorizationEndpoint: 'https://clerk.sprintengine.ai/oauth/authorize',
      tokenEndpoint: 'https://clerk.sprintengine.ai/oauth/token',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
    })

    // Endpoints derive from the issuer when the document omits them, and the
    // scope list falls back to the desktop default.
    const { authorizationEndpoint: _a, tokenEndpoint: _t, scopes: _s, ...bare } = CLERK_DISCOVERY
    const derived = parseIdentityDiscovery(bare, 'sprintengine-desktop')
    assert.equal(derived.provider, 'clerk')
    if (derived.provider === 'clerk') {
      assert.equal(derived.tokenEndpoint, 'https://clerk.sprintengine.ai/oauth/token')
      assert.deepEqual(derived.scopes, CLERK_DESKTOP_SCOPES)
    }

    assert.deepEqual(parseIdentityDiscovery({ provider: 'multiauth', schemaVersion: 1 }, 'sprintengine-desktop'), {
      provider: 'multiauth',
    })
  }

  function discoveryNeverGuesses(): void {
    // Anything malformed is an error, not a silent fallback to either issuer.
    for (const payload of [
      null,
      'clerk',
      {},
      { provider: 'okta' },
      { provider: 'clerk' },
      { provider: 'clerk', issuer: 'http://clerk.example', clientIds: { 'sprintengine-desktop': 'x' } },
      { provider: 'clerk', issuer: 'https://clerk.example', clientIds: { 'sprintengine-mobile': 'x' } },
      { provider: 'clerk', issuer: 'https://clerk.example', clientIds: { 'sprintengine-desktop': '' } },
      {
        provider: 'clerk',
        issuer: 'https://clerk.example',
        clientIds: { 'sprintengine-desktop': 'x' },
        scopes: ['openid'],
      },
      { provider: 'multiauth', schemaVersion: 2 },
    ]) {
      assert.throws(() => parseIdentityDiscovery(payload, 'sprintengine-desktop'), IdentityDiscoveryError)
    }
  }

  function overrideIsTheRollbackLever(): void {
    assert.equal(resolveIdentityOverride({}), null)
    assert.equal(resolveIdentityOverride({ SPRINTENGINE_IDENTITY_PROVIDER: '  ' }), null)
    assert.deepEqual(resolveIdentityOverride({ SPRINTENGINE_IDENTITY_PROVIDER: 'multiauth' }), {
      provider: 'multiauth',
    })

    const clerk = resolveIdentityOverride({
      SPRINTENGINE_IDENTITY_PROVIDER: 'clerk',
      SPRINTENGINE_CLERK_ISSUER: 'https://clerk.example/',
      SPRINTENGINE_CLERK_CLIENT_ID: ' client_x ',
    })
    assert.deepEqual(clerk, {
      provider: 'clerk',
      issuer: 'https://clerk.example',
      clientId: 'client_x',
      authorizationEndpoint: 'https://clerk.example/oauth/authorize',
      tokenEndpoint: 'https://clerk.example/oauth/token',
      scopes: CLERK_DESKTOP_SCOPES,
    })

    assert.throws(() => resolveIdentityOverride({ SPRINTENGINE_IDENTITY_PROVIDER: 'okta' }), IdentityDiscoveryError)
    assert.throws(() => resolveIdentityOverride({ SPRINTENGINE_IDENTITY_PROVIDER: 'clerk' }), IdentityDiscoveryError)
    assert.throws(
      () =>
        resolveIdentityOverride({
          SPRINTENGINE_IDENTITY_PROVIDER: 'clerk',
          SPRINTENGINE_CLERK_ISSUER: 'https://clerk.example',
        }),
      IdentityDiscoveryError,
    )
  }

  function refreshOrderPrefersTheLastSignInButTriesBoth(): void {
    assert.deepEqual(refreshProviderOrder(null, null), ['multiauth', 'clerk'])
    assert.deepEqual(refreshProviderOrder('clerk', null), ['clerk', 'multiauth'])
    assert.deepEqual(refreshProviderOrder('multiauth', null), ['multiauth', 'clerk'])
    // A pinned desktop tries only the pinned provider — the rollback build
    // signs in against the RETAINED Multiauth token and never touches Clerk's.
    assert.deepEqual(refreshProviderOrder('clerk', { provider: 'multiauth' }), ['multiauth'])
    // And the files never collide, so that retained token is still there.
    assert.notEqual(REFRESH_TOKEN_FILE_NAMES.multiauth, REFRESH_TOKEN_FILE_NAMES.clerk)
    assert.equal(REFRESH_TOKEN_FILE_NAMES.multiauth, 'multiauth-refresh-token.bin')
  }

  function authorizationUrlsFollowTheIssuer(): void {
    const request = {
      redirectUri: 'http://127.0.0.1:43110/callback',
      codeChallenge: 'challenge',
      state: 'st',
      nonce: 'nc',
      organizationId: 'org_1',
    }
    const clerkConfig: ClerkIdentityConfig = {
      provider: 'clerk',
      issuer: 'https://clerk.example',
      clientId: 'client_x',
      authorizationEndpoint: 'https://clerk.example/oauth/authorize',
      tokenEndpoint: 'https://clerk.example/oauth/token',
      scopes: CLERK_DESKTOP_SCOPES,
    }

    const clerkUrl = new URL(buildClerkAuthorizationUrl(request, clerkConfig))
    assert.equal(clerkUrl.origin + clerkUrl.pathname, 'https://clerk.example/oauth/authorize')
    assert.equal(clerkUrl.searchParams.get('response_type'), 'code')
    assert.equal(clerkUrl.searchParams.get('client_id'), 'client_x')
    assert.equal(clerkUrl.searchParams.get('redirect_uri'), request.redirectUri)
    assert.equal(clerkUrl.searchParams.get('scope'), 'openid profile email offline_access')
    assert.equal(clerkUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(clerkUrl.searchParams.get('code_challenge'), 'challenge')
    assert.equal(clerkUrl.searchParams.get('state'), 'st')
    // Organisation is a studio concept, never sent to Clerk.
    assert.equal(clerkUrl.searchParams.get('organization_id'), null)

    const multiauthUrl = new URL(
      buildMultiauthAuthorizationUrl(request, {
        baseUrl: 'https://auth.example',
        clientId: 'sprintengine-desktop',
        product: 'sprintengine',
        scope: 'openid profile relay:desktop',
      }),
    )
    assert.equal(multiauthUrl.origin + multiauthUrl.pathname, 'https://auth.example/')
    assert.equal(multiauthUrl.searchParams.get('returnTo'), 'desktop')
    assert.equal(multiauthUrl.searchParams.get('client_id'), 'sprintengine-desktop')
    assert.equal(multiauthUrl.searchParams.get('organization_id'), 'org_1')
    assert.equal(multiauthUrl.searchParams.get('scope'), 'openid profile relay:desktop')
  }

  function tokenRequestsSpeakEachIssuersDialect(): void {
    const exchange = buildClerkCodeExchangeBody({ clientId: 'c', redirectUri: 'r', code: 'code', codeVerifier: 'v' })
    assert.equal(exchange.get('grant_type'), 'authorization_code')
    assert.equal(exchange.get('client_id'), 'c')
    assert.equal(exchange.get('code_verifier'), 'v')
    assert.equal(exchange.get('client_secret'), null)

    const refresh = buildClerkRefreshBody({ clientId: 'c', refreshToken: 'rt' })
    assert.equal(refresh.get('grant_type'), 'refresh_token')
    assert.equal(refresh.get('refresh_token'), 'rt')
  }

  function tokenResponsesNormalise(): void {
    assert.deepEqual(
      parseClerkTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 86400, token_type: 'bearer' }),
      { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 86400 },
    )
    // A refresh grant that does not rotate keeps the credential we hold …
    assert.equal(parseClerkTokenResponse({ access_token: 'at', expires_in: 60 }, 'kept').refreshToken, 'kept')
    // … but a code exchange with no refresh token is a broken grant, not a session.
    assert.throws(() => parseClerkTokenResponse({ access_token: 'at', expires_in: 60 }), TokenResponseError)
    assert.throws(() => parseClerkTokenResponse({ refresh_token: 'rt', expires_in: 60 }), TokenResponseError)
    assert.throws(
      () => parseClerkTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 0 }),
      TokenResponseError,
    )
    assert.throws(
      () => parseClerkTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 60, token_type: 'mac' }),
      TokenResponseError,
    )

    assert.deepEqual(
      parseMultiauthTokenResponse({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 600 }),
      { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 600 },
    )
    assert.throws(() => parseMultiauthTokenResponse({ accessToken: 'at' }), TokenResponseError)
  }

  function errorBodiesReadEitherWay(): void {
    assert.equal(readTokenErrorMessage({ error: { message: 'Session revoked.' } }, 'fallback'), 'Session revoked.')
    assert.equal(
      readTokenErrorMessage({ error: 'invalid_grant', error_description: 'Code already used.' }, 'fallback'),
      'invalid_grant: Code already used.',
    )
    assert.equal(readTokenErrorMessage({ error: 'invalid_client' }, 'fallback'), 'invalid_client')
    assert.equal(readTokenErrorMessage({}, 'fallback'), 'fallback')
    assert.equal(readTokenErrorMessage('nope', 'fallback'), 'fallback')
  }

  function storedClerkConfigIsRevalidated(): void {
    const good = {
      provider: 'clerk',
      issuer: 'https://clerk.example',
      clientId: 'client_x',
      authorizationEndpoint: 'https://clerk.example/oauth/authorize',
      tokenEndpoint: 'https://clerk.example/oauth/token',
      scopes: ['openid', 'offline_access'],
    }
    const pinned = { SPRINTENGINE_CLERK_ISSUER: 'https://clerk.example' }
    assert.deepEqual(parseClerkIdentityConfig(good, pinned), good)
    // Only an issuer Studio knows, or the one the operator pinned: a marker
    // naming any other is ignored, so no refresh token is sent there.
    assert.equal(parseClerkIdentityConfig(good, {}), null)
    const studio = {
      ...good,
      issuer: 'https://clerk.sprintengine.ai',
      authorizationEndpoint: 'https://clerk.sprintengine.ai/oauth/authorize',
      tokenEndpoint: 'https://clerk.sprintengine.ai/oauth/token',
    }
    assert.deepEqual(parseClerkIdentityConfig(studio, {}), studio)
    const lookalike = {
      ...good,
      issuer: 'https://clerk.sprintengine.ai.attacker.example',
      authorizationEndpoint: 'https://clerk.sprintengine.ai.attacker.example/oauth/authorize',
      tokenEndpoint: 'https://clerk.sprintengine.ai.attacker.example/oauth/token',
    }
    assert.equal(parseClerkIdentityConfig(lookalike, {}), null)
    assert.equal(parseClerkIdentityConfig({ ...studio, issuer: 'https://clerk.sprintengine.ai:8443' }, {}), null)
    // The token endpoint must sit on the issuer's origin: a tampered marker
    // must not be able to name where the refresh token is POSTed.
    assert.equal(
      parseClerkIdentityConfig({ ...good, tokenEndpoint: 'https://attacker.example/oauth/token' }, pinned),
      null,
    )
    assert.equal(parseClerkIdentityConfig({ ...good, tokenEndpoint: 'http://clerk.example/oauth/token' }, pinned), null)
    assert.equal(
      parseClerkIdentityConfig({ ...good, authorizationEndpoint: 'https://attacker.example/a' }, pinned),
      null,
    )
    assert.equal(parseClerkIdentityConfig({ ...good, clientId: '' }, pinned), null)
    assert.equal(parseClerkIdentityConfig({ ...good, scopes: 'openid' }, pinned), null)
    assert.equal(parseClerkIdentityConfig({ provider: 'multiauth' }, pinned), null)
    assert.equal(parseClerkIdentityConfig(null), null)
  }

  const cases: Array<[string, () => void]> = [
    ['a stored Clerk config is re-validated before it is trusted', storedClerkConfigIsRevalidated],
    ['discovery parses Clerk and Multiauth documents', discoveryParsesClerkAndMultiauth],
    ['discovery never guesses a provider', discoveryNeverGuesses],
    ['the operator override is the rollback lever', overrideIsTheRollbackLever],
    ['refresh order prefers the last sign-in but tries both stores', refreshOrderPrefersTheLastSignInButTriesBoth],
    ['authorization URLs follow the issuer', authorizationUrlsFollowTheIssuer],
    ["token requests speak each issuer's dialect", tokenRequestsSpeakEachIssuersDialect],
    ['token responses normalise to one token set', tokenResponsesNormalise],
    ['error bodies read either way', errorBodiesReadEitherWay],
  ]

  let failed = 0
  for (const [name, run] of cases) {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  if (failed > 0) {
    process.exit(1)
  }
})
