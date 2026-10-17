/**
 * The account client's session lifecycle, with the account service
 * and Clerk played by an in-process fetch and the safeStorage files by maps.
 * These are the paths the desktop review said were untested: an offline
 * launch that later needs an access token, the pinned-provider rollback, a
 * Clerk failure falling through to the retained Multiauth token, sign-out
 * with the server unreachable, and overlapping refreshes.
 */
import assert from 'node:assert/strict'
import {
  SprintEngineAccountClient,
  ORGANIZATION_HEADER,
  type IdentityMarker,
  type IdentityMarkerStore,
  type SecureRefreshTokenStore,
} from './account-client'
import { IdentityDiscoveryError, type ClerkIdentityConfig, type IdentityEnvironment } from './desktop-identity'
import { test } from 'vitest'

test('account-client', async () => {
  const BASE_URL = 'https://account.example'
  const CLERK: ClerkIdentityConfig = {
    provider: 'clerk',
    issuer: 'https://clerk.example',
    clientId: 'client_desk',
    authorizationEndpoint: 'https://clerk.example/oauth/authorize',
    tokenEndpoint: 'https://clerk.example/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  }

  function tokenStore(initial: string | null = null): SecureRefreshTokenStore & { value: string | null } {
    return {
      value: initial,
      async readRefreshToken() {
        return this.value
      },
      async writeRefreshToken(token) {
        this.value = token
      },
      async clearRefreshToken() {
        this.value = null
      },
    }
  }

  function markerStore(initial: IdentityMarker | null = null): IdentityMarkerStore & { value: IdentityMarker | null } {
    return {
      value: initial,
      async read() {
        return this.value
      },
      async write(marker) {
        this.value = marker
      },
      async clear() {
        this.value = null
      },
    }
  }

  type Call = { url: string; method: string; headers: Headers; body: string | null }

  // A stand-in for the account service and Clerk: routes answer by URL, and a
  // route can be knocked out to simulate the network being gone.
  class Backend {
    calls: Call[] = []
    offline = new Set<string>()
    multiauthRefreshValid = new Set<string>(['ma_rt_1'])
    clerkRefreshValid = new Set<string>(['ck_rt_1'])
    discovery: unknown = {
      provider: 'clerk',
      issuer: CLERK.issuer,
      clientIds: { 'sprintengine-desktop': 'client_desk' },
      scopes: CLERK.scopes,
      schemaVersion: 1,
    }
    discoveryStatus = 200
    defaultOrg = 'org_primary'
    serial = 0

    readonly fetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? init.body : null
      this.calls.push({ url, method: init?.method ?? 'GET', headers, body })
      const origin = new URL(url).origin

      if (this.offline.has(origin)) {
        throw new TypeError('fetch failed')
      }

      if (url === `${BASE_URL}/api/auth/identity`) {
        return this.discoveryStatus === 200
          ? Response.json(this.discovery)
          : new Response('nope', { status: this.discoveryStatus })
      }
      if (url === `${BASE_URL}/api/auth/refresh`) {
        const { refreshToken } = JSON.parse(body ?? '{}') as { refreshToken: string }
        if (!this.multiauthRefreshValid.has(refreshToken)) {
          return Response.json(
            { error: { code: 'REFRESH_TOKEN_REPLAYED', message: 'Refresh token was already used.' } },
            { status: 401 },
          )
        }
        this.multiauthRefreshValid.delete(refreshToken)
        const next = `ma_rt_${++this.serial}`
        this.multiauthRefreshValid.add(next)
        return Response.json({
          accessToken: `ma_at_${this.serial}`,
          refreshToken: next,
          tokenType: 'Bearer',
          expiresIn: 600,
        })
      }
      if (url === `${BASE_URL}/api/auth/desktop/exchange`) {
        return Response.json({ accessToken: 'ma_at_x', refreshToken: 'ma_rt_1', tokenType: 'Bearer', expiresIn: 600 })
      }
      if (url === `${BASE_URL}/api/auth/logout`) {
        return Response.json({ loggedOut: true })
      }
      if (url === `${BASE_URL}/api/auth/me`) {
        return Response.json({
          user: { id: 'usr_1', email: 'a@b', displayName: 'A', avatarUrl: null },
          selectedOrganization: {
            id: headers.get(ORGANIZATION_HEADER) ?? this.defaultOrg,
            name: 'x',
            slug: 'x',
            type: 'team',
          },
        })
      }
      if (url === CLERK.tokenEndpoint) {
        const params = new URLSearchParams(body ?? '')
        if (params.get('grant_type') === 'refresh_token') {
          if (!this.clerkRefreshValid.has(params.get('refresh_token') ?? '')) {
            return Response.json(
              { error: 'invalid_grant', error_description: 'Refresh token revoked.' },
              { status: 400 },
            )
          }
          return Response.json({ access_token: `ck_at_${++this.serial}`, expires_in: 86400, token_type: 'bearer' })
        }
        return Response.json({
          access_token: 'ck_at_x',
          refresh_token: 'ck_rt_1',
          expires_in: 86400,
          token_type: 'bearer',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }
  }

  function client(
    backend: Backend,
    input: {
      multiauth?: string | null
      clerk?: string | null
      marker?: IdentityMarker | null
      env?: IdentityEnvironment
      now?: () => number
    } = {},
  ) {
    const stores = { multiauth: tokenStore(input.multiauth ?? null), clerk: tokenStore(input.clerk ?? null) }
    const marker = markerStore(input.marker ?? null)
    const events: Array<{ event: string; data?: Record<string, unknown> }> = []
    const account = new SprintEngineAccountClient({
      baseUrl: BASE_URL,
      clientId: 'sprintengine-desktop',
      refreshTokenStores: stores,
      identityMarker: marker,
      env: input.env ?? {},
      fetch: backend.fetch,
      now: input.now,
      log: (event, data) => events.push({ event, data }),
    })
    return { account, stores, marker, events }
  }

  async function resumesTheLastProviderAndPrefersItsStore(): Promise<void> {
    const backend = new Backend()
    const { account, marker } = client(backend, {
      multiauth: 'ma_rt_1',
      clerk: 'ck_rt_1',
      marker: { provider: 'clerk', clerk: CLERK },
    })

    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'clerk')
    assert.equal(backend.calls.filter((call) => call.url === `${BASE_URL}/api/auth/refresh`).length, 0)
    assert.equal(marker.value?.provider, 'clerk')
  }

  async function pinnedProviderRollsBackToTheRetainedToken(): Promise<void> {
    const backend = new Backend()
    const { account, stores, events } = client(backend, {
      multiauth: 'ma_rt_1',
      clerk: 'ck_rt_1',
      marker: { provider: 'clerk', clerk: CLERK },
      env: { SPRINTENGINE_IDENTITY_PROVIDER: 'multiauth' },
    })

    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'multiauth')
    // Clerk was never contacted, and its token is still there for the flip forward.
    assert.equal(backend.calls.filter((call) => call.url === CLERK.tokenEndpoint).length, 0)
    assert.equal(stores.clerk.value, 'ck_rt_1')
    assert.deepEqual(events.find((entry) => entry.event === 'identity-resumed')?.data, {
      provider: 'multiauth',
      pinned: true,
    })
  }

  async function clerkFailureFallsThroughToMultiauth(): Promise<void> {
    const backend = new Backend()
    backend.clerkRefreshValid.clear()
    const { account, marker, events } = client(backend, {
      multiauth: 'ma_rt_1',
      clerk: 'ck_rt_1',
      marker: { provider: 'clerk', clerk: CLERK },
    })

    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'multiauth')
    assert.equal(marker.value?.provider, 'multiauth')
    assert.equal(events.find((entry) => entry.event === 'identity-resumed')?.data?.provider, 'multiauth')
  }

  async function offlineLaunchThenAccessTokenOnceOnline(): Promise<void> {
    const backend = new Backend()
    backend.offline.add(BASE_URL).add(CLERK.issuer)
    const { account } = client(backend, { multiauth: 'ma_rt_1', marker: { provider: 'multiauth' } })

    await assert.rejects(account.resumeStoredSession())
    assert.equal(account.currentIdentity(), null)

    backend.offline.clear()
    // A caller asks for a token later; the session must come back from disk.
    const token = await account.getAccessToken()
    assert.match(token, /^ma_at_/u)
    assert.equal(account.currentIdentity()?.provider, 'multiauth')
  }

  async function overlappingRefreshesShareOneRoundTrip(): Promise<void> {
    const backend = new Backend()
    let now = Date.now()
    const { account } = client(backend, { multiauth: 'ma_rt_1', marker: { provider: 'multiauth' }, now: () => now })
    await account.resumeStoredSession()
    now += 700 * 1000 // past the 600s token

    const [a, b, c] = await Promise.all([account.getAccessToken(), account.getAccessToken(), account.getAccessToken()])
    assert.equal(a, b)
    assert.equal(b, c)
    // Two refreshes in total: the resume and the one shared refresh. A third
    // would have replayed a rotated token and revoked the session.
    assert.equal(backend.calls.filter((call) => call.url === `${BASE_URL}/api/auth/refresh`).length, 2)
  }

  async function logoutClearsEverythingEvenWhenTheServerIsGone(): Promise<void> {
    const backend = new Backend()
    const { account, stores, marker, events } = client(backend, {
      multiauth: 'ma_rt_1',
      clerk: 'ck_rt_1',
      marker: { provider: 'clerk', clerk: CLERK },
    })
    await account.resumeStoredSession()
    backend.offline.add(BASE_URL)

    const result = await account.logout()
    assert.deepEqual(result, { loggedOut: true })
    assert.equal(stores.multiauth.value, null)
    assert.equal(stores.clerk.value, null)
    assert.equal(marker.value, null)
    assert.equal(account.currentIdentity(), null)
    assert.ok(events.some((entry) => entry.event === 'server-logout-failed-local-session-cleared'))
  }

  async function logoutRevokesARetainedMultiauthTokenEvenUnderClerk(): Promise<void> {
    const backend = new Backend()
    const { account } = client(backend, {
      multiauth: 'ma_rt_1',
      clerk: 'ck_rt_1',
      marker: { provider: 'clerk', clerk: CLERK },
    })
    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'clerk')

    await account.logout()
    const logout = backend.calls.find((call) => call.url === `${BASE_URL}/api/auth/logout`)
    assert.ok(logout)
    assert.deepEqual(JSON.parse(logout.body ?? '{}'), { refreshToken: 'ma_rt_1' })
  }

  async function selectedOrganisationRidesOnEveryBearerCall(): Promise<void> {
    const backend = new Backend()
    const { account } = client(backend, { clerk: 'ck_rt_1', marker: { provider: 'clerk', clerk: CLERK } })
    await account.resumeStoredSession()
    await account.selectOrganization('org_team')

    const profile = await account.getProfile()
    assert.equal(profile.selectedOrganization.id, 'org_team')
    for (const call of backend.calls.filter(
      (entry) => entry.url.startsWith(`${BASE_URL}/api/`) && entry.headers.has('authorization'),
    )) {
      assert.equal(call.headers.get(ORGANIZATION_HEADER), 'org_team', call.url)
    }
  }

  async function discoveryDecidesTheLoginIssuer(): Promise<void> {
    const backend = new Backend()
    const { account } = client(backend)

    const clerk = await account.resolveIdentityForLogin()
    assert.equal(clerk.provider, 'clerk')

    backend.discoveryStatus = 404
    assert.deepEqual(await account.resolveIdentityForLogin(), { provider: 'multiauth' })

    backend.discoveryStatus = 500
    await assert.rejects(account.resolveIdentityForLogin(), IdentityDiscoveryError)

    backend.discoveryStatus = 200
    backend.discovery = { provider: 'clerk', issuer: CLERK.issuer, clientIds: { 'sprintengine-mobile': 'client_mob' } }
    await assert.rejects(account.resolveIdentityForLogin(), IdentityDiscoveryError)

    const pinned = client(backend, { env: { SPRINTENGINE_IDENTITY_PROVIDER: 'multiauth' } })
    assert.deepEqual(await pinned.account.resolveIdentityForLogin(), { provider: 'multiauth' })
  }

  async function clerkTokenWithoutMarkerResumesViaDiscovery(): Promise<void> {
    const backend = new Backend()
    const { account } = client(backend, { clerk: 'ck_rt_1', marker: null })

    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'clerk')
    assert.ok(backend.calls.some((call) => call.url === `${BASE_URL}/api/auth/identity`))
  }

  async function codeExchangeInstallsTheIssuerItCameFrom(): Promise<void> {
    const backend = new Backend()
    const { account, stores, marker } = client(backend)

    await account.exchangeCode({
      identity: CLERK,
      redirectUri: 'http://127.0.0.1:43110/callback',
      code: 'c',
      codeVerifier: 'v',
    })
    assert.equal(stores.clerk.value, 'ck_rt_1')
    assert.equal(stores.multiauth.value, null)
    assert.deepEqual(marker.value, { provider: 'clerk', clerk: CLERK, baseUrl: BASE_URL, organizationId: null })
    const exchange = backend.calls.find((call) => call.url === CLERK.tokenEndpoint)
    assert.equal(exchange?.headers.get('content-type'), 'application/x-www-form-urlencoded')
    assert.equal(new URLSearchParams(exchange?.body ?? '').get('grant_type'), 'authorization_code')

    await account.exchangeCode({
      identity: { provider: 'multiauth' },
      redirectUri: 'http://127.0.0.1:43110/callback',
      code: 'c',
      codeVerifier: 'v',
    })
    assert.equal(stores.multiauth.value, 'ma_rt_1')
    // The Clerk token is retained: rollback inside the window depends on it.
    assert.equal(stores.clerk.value, 'ck_rt_1')
    assert.deepEqual(marker.value, { provider: 'multiauth', baseUrl: BASE_URL, organizationId: null })
  }

  async function logoutDuringARefreshIsNotUndone(): Promise<void> {
    const backend = new Backend()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holdTokenRequests = false
    const slowFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (holdTokenRequests && url === CLERK.tokenEndpoint) await gate
      return backend.fetch(input, init)
    }
    const stores = { multiauth: tokenStore(null), clerk: tokenStore('ck_rt_1') }
    const marker = markerStore({ provider: 'clerk', clerk: CLERK })
    let now = Date.now()
    const account = new SprintEngineAccountClient({
      baseUrl: BASE_URL,
      clientId: 'sprintengine-desktop',
      refreshTokenStores: stores,
      identityMarker: marker,
      env: {},
      fetch: slowFetch,
      now: () => now,
    })
    await account.resumeStoredSession()
    now += 2 * 86400 * 1000
    holdTokenRequests = true

    const pending = account.getAccessToken()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await account.logout()
    release()
    await assert.rejects(pending)

    assert.equal(account.currentIdentity(), null)
    assert.equal(stores.clerk.value, null)
    assert.equal(marker.value, null)
    await assert.rejects(account.getAccessToken())
  }

  async function selectedOrganisationSurvivesARestart(): Promise<void> {
    const backend = new Backend()
    const first = client(backend, { clerk: 'ck_rt_1', marker: { provider: 'clerk', clerk: CLERK } })
    await first.account.resumeStoredSession()
    await first.account.selectOrganization('org_team')
    assert.equal(first.marker.value?.organizationId, 'org_team')
    assert.equal(first.marker.value?.baseUrl, BASE_URL)

    // "Restart": a fresh client over the same files.
    const second = client(backend, { clerk: first.stores.clerk.value, marker: first.marker.value })
    await second.account.resumeStoredSession()
    assert.equal(second.account.selectedOrganization(), 'org_team')
    const profile = await second.account.getProfile()
    assert.equal(profile.selectedOrganization.id, 'org_team')
  }

  async function aMarkerFromAnotherAccountServiceIsIgnored(): Promise<void> {
    const backend = new Backend()
    const { account, events } = client(backend, {
      clerk: 'ck_rt_1',
      multiauth: 'ma_rt_1',
      marker: { provider: 'clerk', clerk: CLERK, baseUrl: 'https://other.example', organizationId: 'org_elsewhere' },
    })
    backend.discoveryStatus = 404 // this account service is a Multiauth one

    await account.resumeStoredSession()
    assert.equal(account.currentIdentity()?.provider, 'multiauth')
    assert.equal(account.selectedOrganization(), null)
    assert.equal(backend.calls.filter((call) => call.url === CLERK.tokenEndpoint).length, 0)
    assert.ok(events.some((entry) => entry.event === 'identity-marker-foreign-base-url'))
  }

  const cases: Array<[string, () => Promise<void>]> = [
    ['a sign-out during a refresh is not undone by the refresh landing', logoutDuringARefreshIsNotUndone],
    ['the selected organisation survives a restart', selectedOrganisationSurvivesARestart],
    ['a marker from another account service is ignored', aMarkerFromAnotherAccountServiceIsIgnored],
    ['resumes the last provider and prefers its store', resumesTheLastProviderAndPrefersItsStore],
    [
      'a pinned provider rolls back to the retained token without touching Clerk',
      pinnedProviderRollsBackToTheRetainedToken,
    ],
    ['a Clerk refresh failure falls through to the retained Multiauth token', clerkFailureFallsThroughToMultiauth],
    ['an offline launch still yields an access token once the network is back', offlineLaunchThenAccessTokenOnceOnline],
    ['overlapping refreshes share one round trip', overlappingRefreshesShareOneRoundTrip],
    [
      'logout clears both stores and the marker even when the server is gone',
      logoutClearsEverythingEvenWhenTheServerIsGone,
    ],
    [
      'logout revokes a retained Multiauth token even under a Clerk session',
      logoutRevokesARetainedMultiauthTokenEvenUnderClerk,
    ],
    ['the selected organisation rides on every bearer call', selectedOrganisationRidesOnEveryBearerCall],
    ['discovery decides the login issuer, and never guesses', discoveryDecidesTheLoginIssuer],
    ['a Clerk token with no marker resumes via discovery', clerkTokenWithoutMarkerResumesViaDiscovery],
    [
      'a code exchange installs the issuer it came from and keeps the other store',
      codeExchangeInstallsTheIssuerItCameFrom,
    ],
  ]

  // A hung case must fail loudly: with nothing left on the event loop Node
  // exits 0 without a word, which reads as green.
  const watchdog = setTimeout(() => {
    console.error('not ok - the run did not finish within 30s')
    process.exit(1)
  }, 30_000)

  const suiteRun = (async () => {
    let failed = 0
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`ok - ${name}`)
      } catch (error) {
        failed += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }
    clearTimeout(watchdog)
    if (failed > 0) process.exit(1)
  })()

  await suiteRun
})

test('a token request whose body never ends gives up at its deadline, and the next resume asks afresh', async () => {
  const store = (value: string | null): SecureRefreshTokenStore => ({
    readRefreshToken: async () => value,
    writeRefreshToken: async (token) => void (value = token),
    clearRefreshToken: async () => void (value = null),
  })
  let marker: IdentityMarker | null = { provider: 'multiauth' }
  let stalled = true
  let refreshes = 0
  const account = new SprintEngineAccountClient({
    baseUrl: 'https://account.example',
    clientId: 'sprintengine-desktop',
    refreshTokenStores: { multiauth: store('ma_rt_1'), clerk: store(null) },
    identityMarker: {
      read: async () => marker,
      write: async (next) => void (marker = next),
      clear: async () => void (marker = null),
    },
    env: {},
    requestTimeoutMs: 50,
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/api/auth/refresh')) {
        refreshes += 1
        if (stalled) {
          // Headers, then an opening brace, then nothing: the shape of a
          // proxy that holds the connection open.
          const body = new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{')),
          })
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return Response.json({ accessToken: 'ma_at_2', refreshToken: 'ma_rt_2', tokenType: 'Bearer', expiresIn: 600 })
      }
      if (url.endsWith('/api/auth/me')) {
        return Response.json({ user: { id: 'usr_1', email: 'dev@example.com', displayName: 'Dev', avatarUrl: null } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    },
  })

  await assert.rejects(account.resumeStoredSession(), /account\.example did not answer within 0 s/u)
  assert.equal(account.currentIdentity(), null)

  stalled = false
  await account.resumeStoredSession()
  assert.equal(account.currentIdentity()?.provider, 'multiauth')
  assert.equal(refreshes, 2, 'the stalled request was let go, not shared with the next caller')
})
