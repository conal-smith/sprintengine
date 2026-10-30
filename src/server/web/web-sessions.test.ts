import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  PAIRING_CODE_TTL_MS,
  SESSION_LIFETIME_MS,
  TICKET_TTL_MS,
  WEB_SESSIONS_FILENAME,
  browserNameFromUserAgent,
  createWebSessionStore,
  webSessionCookieName,
} from './web-sessions'

const ENVIRONMENT = '05763914-5fa0-449b-96d7-15af49e0ec86'
let dataDir: string
let now: number

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'web-sessions-'))
  now = Date.parse('2026-10-03T00:00:00Z')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const store = () => createWebSessionStore({ dataDir, environmentId: ENVIRONMENT, now: () => now })

test('the cookie is named for the environment, so servers on one loopback do not share a jar entry', () => {
  expect(webSessionCookieName(ENVIRONMENT)).toBe('se_s_057639145fa0')
  expect(webSessionCookieName('ffffffff-0000-0000-0000-000000000000')).not.toBe(webSessionCookieName(ENVIRONMENT))
  expect(store().cookieName).toBe('se_s_057639145fa0')
})

test('a pairing code is spent by being presented, and pairs a browser with the owner grant', () => {
  const sessions = store()
  const { code } = sessions.mintPairingCode()
  const exchanged = sessions.exchange(code, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140',
    route: 'loopback',
  })
  expect(exchanged.ok).toBe(true)
  if (!exchanged.ok) return
  expect(exchanged.session).toMatchObject({ kind: 'web', name: 'Chrome on macOS', owner: true, route: 'loopback' })
  expect(sessions.exchange(code, { route: 'loopback' }).ok).toBe(false)
  expect(sessions.authenticate([exchanged.secret])?.id).toBe(exchanged.session.id)
})

test('a code is spent even when the exchange is refused', () => {
  const sessions = store()
  const { code } = sessions.mintPairingCode()
  now += PAIRING_CODE_TTL_MS + 1
  expect(sessions.exchange(code, { route: 'loopback' }).ok).toBe(false)
  now -= PAIRING_CODE_TTL_MS + 1
  expect(sessions.exchange(code, { route: 'loopback' }).ok).toBe(false)
})

test('a browser that paired over the tailnet is the owner’s, but never offers tools', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'tailnet' })
  expect(exchanged.ok && exchanged.session.route).toBe('tailnet')
  expect(exchanged.ok && exchanged.session.scopes).not.toContain('tools:offer')
  expect(exchanged.ok && sessions.grantFor(exchanged.session.id)?.scopes).not.toContain('tools:offer')
})

test('only the hash reaches disk, owner-only', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'loopback' })
  const file = join(dataDir, WEB_SESSIONS_FILENAME)
  const written = readFileSync(file, 'utf8')
  expect(exchanged.ok && written.includes(exchanged.secret)).toBe(false)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  // A second store over the same directory knows the session.
  expect(exchanged.ok && store().authenticate([exchanged.secret])?.id).toBe(exchanged.ok && exchanged.session.id)
})

test('a session lives thirty days from pairing, however often it is used', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'loopback' })
  if (!exchanged.ok) throw new Error('not paired')
  now += SESSION_LIFETIME_MS - 1000
  sessions.recordSeen(exchanged.session.id)
  expect(sessions.authenticate([exchanged.secret])).not.toBeNull()
  now += 2000
  expect(sessions.authenticate([exchanged.secret])).toBeNull()
  expect(sessions.grantFor(exchanged.session.id)).toBeNull()
})

test('a session that runs out is announced as revoked when the list is next read, so its sockets close', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'loopback' })
  if (!exchanged.ok) throw new Error('not paired')
  const heard: string[] = []
  sessions.onRevoked((id) => heard.push(id))
  now += SESSION_LIFETIME_MS + 1
  // The front door reads the list once a minute for exactly this.
  expect(sessions.list()).toEqual([])
  expect(heard).toEqual([exchanged.session.id])
})

test('every cookie value is tried: a shadowing cookie set by another local page does not hide the real one', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'loopback' })
  if (!exchanged.ok) throw new Error('not paired')
  expect(sessions.authenticate(['sesess_planted-by-a-dev-server', exchanged.secret])?.id).toBe(exchanged.session.id)
})

test('revoking a session tells its listeners and refuses its cookie at once', () => {
  const sessions = store()
  const exchanged = sessions.exchange(sessions.mintPairingCode().code, { route: 'loopback' })
  if (!exchanged.ok) throw new Error('not paired')
  const heard: string[] = []
  sessions.onRevoked((id) => heard.push(id))
  expect(sessions.revoke(exchanged.session.id)).toBe(true)
  expect(heard).toEqual([exchanged.session.id])
  expect(sessions.authenticate([exchanged.secret])).toBeNull()
})

test('a ticket is single use and lives thirty seconds', () => {
  const sessions = store()
  const first = sessions.mintTicket({ kind: 'embed', embedId: 'embed-1' })
  expect(sessions.redeemTicket(first.ticket)).toEqual({ kind: 'embed', embedId: 'embed-1' })
  expect(sessions.redeemTicket(first.ticket)).toBeNull()
  const late = sessions.mintTicket({ kind: 'embed', embedId: 'embed-1' })
  now += TICKET_TTL_MS + 1
  expect(sessions.redeemTicket(late.ticket)).toBeNull()
})

test('a browser is named from its user agent', () => {
  expect(browserNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605')).toBe(
    'Safari on iOS',
  )
  expect(browserNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0) Firefox/140.0')).toBe('Firefox on Windows')
  expect(browserNameFromUserAgent(undefined)).toBe('Browser')
})

test('a phone browser is named for itself, not the engine its user agent also names', () => {
  const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko)'
  expect(browserNameFromUserAgent(`${ios} EdgiOS/140.0 Version/18.0 Mobile/15E148 Safari/604.1`)).toBe('Edge on iOS')
  expect(browserNameFromUserAgent(`${ios} FxiOS/140.0 Mobile/15E148 Safari/605.1.15`)).toBe('Firefox on iOS')
  expect(browserNameFromUserAgent(`${ios} CriOS/140.0 Mobile/15E148 Safari/604.1`)).toBe('Chrome on iOS')
  expect(browserNameFromUserAgent(`${ios} OPiOS/16.0 Mobile/15E148 Safari/9537.53`)).toBe('Opera on iOS')
  expect(browserNameFromUserAgent(`${android} Chrome/140.0 Mobile Safari/537.36 EdgA/140.0`)).toBe('Edge on Android')
  expect(browserNameFromUserAgent(`${android} Chrome/140.0 Mobile Safari/537.36 OPR/90.0`)).toBe('Opera on Android')
  expect(browserNameFromUserAgent(`${android} Chrome/140.0 Mobile Safari/537.36`)).toBe('Chrome on Android')
})
