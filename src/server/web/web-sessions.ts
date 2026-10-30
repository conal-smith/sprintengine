import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  STUDIO_SCOPES,
  normalizeStudioScopes,
  type StudioGrant,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import { hashSecret, secretsMatch } from '../../main/automation/tailnet/secret-hash'
import { writeFileAtomicSync } from '../platform/atomic-file'

// The browsers paired with this server, and how each proves it (phase 9 spec,
// 6.2 and 6.3; decisions R14, R15 and R18).
//
// A browser pairs once, by a one-time code minted for it, and from then on
// holds a session cookie. Each paired browser is a device of kind `web`: it is
// listed, named and revocable like any other, and revoking it closes its
// streams on the next frame. Only hashes reach disk (0600): a copied store
// file cannot be presented back, and an outstanding code lives in this process
// alone, so a restart voids every unspent one.
//
// - A pairing code is 32 random bytes, good for five minutes, and spent the
//   first time it is presented, whether the exchange then succeeds or not.
// - A session lives 30 days from pairing and no longer, however often it is
//   used (R18): a ceiling bounds what a stolen cookie is worth.
// - The cookie is named for this server's environment (`se_s_<12 hex>`, R15),
//   because every server reachable on 127.0.0.1 shares one cookie jar. A
//   request may carry several cookies of that name (a page on another local
//   port can set one for the host); every value is tried, and the one that
//   verifies wins, never merely the first.
// - A ticket is the credential of a client that cannot send a cookie (the
//   embed, an SDK client): single use, thirty seconds, kept as a hash.

export const WEB_SESSIONS_FILENAME = 'web-sessions.json'
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const TICKET_TTL_MS = 30 * 1000
const MAX_CODES = 16
const MAX_SESSIONS = 64
const MAX_TICKETS = 256
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000

/** How a browser reached the server when it paired: on this machine, or through the tailnet's HTTPS name. */
export type WebRoute = 'loopback' | 'tailnet'

/** A paired browser, as Settings and `studio-server sessions` show it. Never its secret. */
export type WebSession = {
  id: string
  name: string
  kind: 'web'
  route: WebRoute
  /** The owner's grant, or a narrower one; read live on every frame. */
  owner: boolean
  scopes: StudioScope[]
  createdAt: string
  expiresAt: string
  lastSeenAt: string | null
}

type StoredSession = WebSession & { secretHash: string }
type PairingCode = { hash: string; expiresAtMs: number; route: WebRoute; owner: boolean }

export type WebTicketSubject = { kind: 'session'; sessionId: string } | { kind: 'embed'; embedId: string }
type Ticket = { hash: string; expiresAtMs: number; subject: WebTicketSubject }

/** The scopes a tailnet browser holds: everything but offering tools (P5c §7.1, R79). */
const TAILNET_SCOPES: StudioScope[] = STUDIO_SCOPES.filter((scope) => scope !== 'tools:offer')

export type WebSessionStore = {
  /** The cookie this server's sessions are kept under. */
  cookieName: string
  /** Mint a one-time pairing code for a browser. */
  mintPairingCode(input?: { route?: WebRoute }): { code: string; expiresAt: string }
  /**
   * Spend a pairing code for a session. The code is spent by being presented,
   * whatever happens next.
   */
  exchange(
    code: string,
    input: { userAgent?: string | null; route: WebRoute },
  ): { ok: true; session: WebSession; secret: string } | { ok: false; message: string }
  /**
   * Make a session for a browser the owner let in another way (an approved
   * pairing request). The owner's own unless `owner: false` says otherwise.
   */
  issue(input: {
    userAgent?: string | null
    name?: string
    route: WebRoute
    owner?: boolean
  }): { ok: true; session: WebSession; secret: string } | { ok: false; message: string }
  /** The live session one of these cookie values proves, or null. */
  authenticate(secrets: readonly string[]): WebSession | null
  get(id: string): WebSession | null
  list(): WebSession[]
  rename(id: string, name: string): boolean
  revoke(id: string): boolean
  onRevoked(listener: (sessionId: string) => void): () => void
  /** Hear any change to the list: a browser paired, renamed or removed. */
  onChanged(listener: () => void): () => void
  /** The grant a session holds now, or null once it is revoked or has expired. */
  grantFor(sessionId: string): StudioGrant | null
  recordSeen(id: string): void
  /** A single-use credential for a socket that cannot carry the cookie. */
  mintTicket(subject: WebTicketSubject): { ticket: string; expiresAt: string }
  /** Spend a ticket: what it was minted for, once, within its thirty seconds. */
  redeemTicket(ticket: string): WebTicketSubject | null
}

export const WEB_PAIRING_FAILED =
  'This pairing link was used or has expired. Make a new one in Studio (studio-server pair).'

/** The cookie name for an environment: `se_s_` and the first twelve hex digits of its id. */
export function webSessionCookieName(environmentId: string): string {
  const hex = environmentId.replace(/[^0-9a-f]/giu, '').toLowerCase()
  return `se_s_${hex.slice(0, 12).padEnd(12, '0')}`
}

/** A browser's name from its user agent, which the person can change. */
export function browserNameFromUserAgent(userAgent: string | null | undefined): string {
  const agent = userAgent ?? ''
  // Phone builds name themselves apart from the desktop token (`EdgA/`,
  // `EdgiOS/`, `FxiOS/`, `CriOS/`, `OPiOS/`) and still carry Chrome's or
  // Safari's, so each is checked before the engine it reports alongside.
  const browser = /Edg(?:e|A|iOS)?\//u.test(agent)
    ? 'Edge'
    : /OPR\/|OPiOS\//u.test(agent)
      ? 'Opera'
      : /Firefox\/|FxiOS\//u.test(agent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//u.test(agent)
          ? 'Chrome'
          : /Safari\//u.test(agent)
            ? 'Safari'
            : 'Browser'
  const os = /iPhone|iPad/u.test(agent)
    ? 'iOS'
    : /Android/u.test(agent)
      ? 'Android'
      : /Mac OS X|Macintosh/u.test(agent)
        ? 'macOS'
        : /Windows/u.test(agent)
          ? 'Windows'
          : /Linux/u.test(agent)
            ? 'Linux'
            : null
  return os ? `${browser} on ${os}` : browser
}

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

function sanitizeName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 80)
}

export function createWebSessionStore(options: {
  dataDir: string
  environmentId: string
  now?: () => number
  log?: (message: string) => void
}): WebSessionStore {
  const now = options.now ?? Date.now
  const path = join(options.dataDir, WEB_SESSIONS_FILENAME)
  const codes: PairingCode[] = []
  const tickets: Ticket[] = []
  const revokedListeners = new Set<(sessionId: string) => void>()
  const changedListeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...changedListeners]) listener()
  }
  const lastPersistedSeen = new Map<string, number>()
  let sessions: StoredSession[] = load()

  function load(): StoredSession[] {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown }
      if (!Array.isArray(raw.sessions)) return []
      return raw.sessions.flatMap((entry): StoredSession[] => {
        const value = entry as Partial<StoredSession> | null
        if (
          !value ||
          typeof value.id !== 'string' ||
          typeof value.secretHash !== 'string' ||
          typeof value.createdAt !== 'string' ||
          typeof value.expiresAt !== 'string'
        )
          return []
        return [
          {
            id: value.id,
            name: typeof value.name === 'string' ? sanitizeName(value.name) || 'Browser' : 'Browser',
            kind: 'web',
            route: value.route === 'tailnet' ? 'tailnet' : 'loopback',
            owner: value.owner === true,
            scopes: normalizeStudioScopes(value.scopes),
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null,
            secretHash: value.secretHash,
          },
        ]
      })
    } catch {
      return []
    }
  }

  function save(): void {
    writeFileAtomicSync(path, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600, exactMode: true })
  }

  const view = ({ secretHash: _secretHash, ...session }: StoredSession): WebSession => ({
    ...session,
    scopes: [...session.scopes],
  })
  const live = (session: StoredSession): boolean => Date.parse(session.expiresAt) > now()

  function prune(): void {
    const at = now()
    for (let index = codes.length - 1; index >= 0; index--) if (codes[index].expiresAtMs <= at) codes.splice(index, 1)
    for (let index = tickets.length - 1; index >= 0; index--)
      if (tickets[index].expiresAtMs <= at) tickets.splice(index, 1)
    const expired = sessions.filter((session) => !live(session))
    if (expired.length > 0) {
      sessions = sessions.filter(live)
      save()
      for (const session of expired) announceRevoked(session.id)
    }
  }

  function announceRevoked(sessionId: string): void {
    changed()
    for (const listener of [...revokedListeners]) {
      try {
        listener(sessionId)
      } catch (error) {
        options.log?.(`a revocation listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function issue(input: {
    userAgent?: string | null
    name?: string
    route: WebRoute
    owner: boolean
  }): { ok: true; session: WebSession; secret: string } | { ok: false; message: string } {
    if (sessions.length >= MAX_SESSIONS) {
      return { ok: false, message: `Studio holds ${MAX_SESSIONS} paired browsers already. Remove one first.` }
    }
    const value = secret('sesess_')
    const at = now()
    const stored: StoredSession = {
      id: randomUUID(),
      name: (input.name ? sanitizeName(input.name) : '') || browserNameFromUserAgent(input.userAgent),
      kind: 'web',
      route: input.route,
      owner: input.owner,
      // A tailnet browser never offers tools (R79); what else it may not do
      // is held where it is served (no previews, no folder browser).
      scopes: input.route === 'loopback' ? [...STUDIO_SCOPES] : [...TAILNET_SCOPES],
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + SESSION_LIFETIME_MS).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
      secretHash: hashSecret(value),
    }
    sessions = [...sessions, stored]
    save()
    changed()
    return { ok: true, session: view(stored), secret: value }
  }

  return {
    cookieName: webSessionCookieName(options.environmentId),

    mintPairingCode(input = {}) {
      prune()
      if (codes.length >= MAX_CODES) codes.shift()
      const code = secret('sepair_')
      const expiresAtMs = now() + PAIRING_CODE_TTL_MS
      // A code minted for the tailnet pairs a browser that may not offer tools.
      const route = input.route ?? 'loopback'
      codes.push({ hash: hashSecret(code), expiresAtMs, route, owner: true })
      return { code, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    exchange(code, input) {
      prune()
      const hash = hashSecret(code)
      const index = codes.findIndex((entry) => secretsMatch(entry.hash, hash))
      if (index < 0) return { ok: false, message: WEB_PAIRING_FAILED }
      const [spent] = codes.splice(index, 1)
      if (spent.expiresAtMs <= now()) return { ok: false, message: WEB_PAIRING_FAILED }
      // A browser that arrived over the tailnet never holds more than a
      // tailnet pairing may, whatever the code was minted for.
      const route: WebRoute = spent.route === 'tailnet' || input.route === 'tailnet' ? 'tailnet' : 'loopback'
      return issue({ userAgent: input.userAgent ?? null, route, owner: spent.owner })
    },

    issue: (input) => issue({ ...input, owner: input.owner ?? true }),

    authenticate(secrets) {
      if (secrets.length === 0) return null
      prune()
      for (const presented of secrets) {
        const hash = hashSecret(presented)
        const found = sessions.find((session) => secretsMatch(session.secretHash, hash))
        if (found && live(found)) return view(found)
      }
      return null
    },

    get(id) {
      const found = sessions.find((session) => session.id === id)
      return found && live(found) ? view(found) : null
    },

    list() {
      prune()
      return sessions.map(view)
    },

    rename(id, name) {
      const clean = sanitizeName(name)
      const found = sessions.find((session) => session.id === id)
      if (!found || !clean) return false
      found.name = clean
      save()
      changed()
      return true
    },

    revoke(id) {
      const before = sessions.length
      sessions = sessions.filter((session) => session.id !== id)
      if (sessions.length === before) return false
      save()
      for (let index = tickets.length - 1; index >= 0; index--) {
        const subject = tickets[index].subject
        if (subject.kind === 'session' && subject.sessionId === id) tickets.splice(index, 1)
      }
      announceRevoked(id)
      return true
    },

    onRevoked(listener) {
      revokedListeners.add(listener)
      return () => revokedListeners.delete(listener)
    },

    onChanged(listener) {
      changedListeners.add(listener)
      return () => changedListeners.delete(listener)
    },

    grantFor(sessionId) {
      const found = sessions.find((session) => session.id === sessionId)
      if (!found || !live(found)) return null
      return {
        clientId: `web:${found.id}`,
        name: found.name,
        owner: found.owner,
        scopes: [...found.scopes],
        ceiling: 'bypass',
      }
    },

    recordSeen(id) {
      const found = sessions.find((session) => session.id === id)
      if (!found) return
      const at = now()
      found.lastSeenAt = new Date(at).toISOString()
      if (at - (lastPersistedSeen.get(id) ?? 0) < LAST_SEEN_PERSIST_INTERVAL_MS) return
      lastPersistedSeen.set(id, at)
      try {
        save()
      } catch (error) {
        options.log?.(
          `A browser's last-seen time was not saved: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    mintTicket(subject) {
      prune()
      if (tickets.length >= MAX_TICKETS) tickets.shift()
      const ticket = secret('seticket_')
      const expiresAtMs = now() + TICKET_TTL_MS
      tickets.push({ hash: hashSecret(ticket), expiresAtMs, subject })
      return { ticket, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    redeemTicket(ticket) {
      const hash = hashSecret(ticket)
      const index = tickets.findIndex((entry) => secretsMatch(entry.hash, hash))
      if (index < 0) return null
      const [spent] = tickets.splice(index, 1)
      return spent.expiresAtMs > now() ? spent.subject : null
    },
  }
}
