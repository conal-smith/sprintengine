import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import { hashSecret, secretsMatch } from '../../main/automation/tailnet/secret-hash'
import type { WebRoute, WebSession, WebSessionStore } from './web-sessions'
import { browserNameFromUserAgent } from './web-sessions'

// Pairing a browser by approval (phase 9 spec, 6.2): a browser on another
// device opens the pairing page, names itself and is shown six digits; the
// owner, in Studio, sees the request and types those digits to let it in.
// Typing them is the check that the browser asking is the one in front of the
// owner, not one somewhere else that asked at the same moment. Three wrong
// tries decline the request.
//
// The browser polls with a collect secret only it holds; once approved, its
// next poll is answered with the session cookie, once. A request lives five
// minutes; at most eight wait at once, so a stranger on the tailnet cannot
// bury the owner's Settings in requests.

export const PAIR_REQUEST_TTL_MS = 5 * 60 * 1000
const MAX_PENDING = 8
const MAX_TRIES = 3

export type PairRequestView = {
  requestId: string
  name: string
  route: WebRoute
  createdAt: string
  expiresAt: string
}

type PairRequest = PairRequestView & {
  code: string
  collectHash: string
  expiresAtMs: number
  tries: number
  state: 'pending' | 'approved' | 'declined'
  userAgent: string | null
}

export type PairCollect =
  | { status: 'pending' }
  | { status: 'declined' }
  | { status: 'expired' }
  | { status: 'approved'; session: WebSession; secret: string }
  | { status: 'failed'; message: string }

export type PairRequests = {
  /** A browser asks. Answers its id, the six digits it shows, and the secret it polls with. */
  create(input: {
    name?: unknown
    userAgent: string | null
    route: WebRoute
  }): { ok: true; requestId: string; code: string; collect: string; expiresAt: string } | { ok: false; message: string }
  /** What is waiting for the owner. */
  pending(): PairRequestView[]
  approve(requestId: string, code: string): { ok: true } | { ok: false; message: string }
  decline(requestId: string): boolean
  /** The browser's poll. A session is handed over once, on the first poll after approval. */
  collect(requestId: string, collect: string): PairCollect
  onChanged(listener: () => void): () => void
}

export function createPairRequests(options: { sessions: WebSessionStore; now?: () => number }): PairRequests {
  const now = options.now ?? Date.now
  let requests: PairRequest[] = []
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }
  const view = (request: PairRequest): PairRequestView => ({
    requestId: request.requestId,
    name: request.name,
    route: request.route,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  })
  function prune(): void {
    const before = requests.length
    requests = requests.filter((request) => request.expiresAtMs > now())
    if (requests.length !== before) changed()
  }
  return {
    create(input) {
      prune()
      if (requests.filter((request) => request.state === 'pending').length >= MAX_PENDING)
        return { ok: false, message: 'Studio has too many browsers waiting to pair. Try again in a few minutes.' }
      const name =
        typeof input.name === 'string' && input.name.trim()
          ? input.name
              .replace(/[\u0000-\u001f\u007f]/gu, '')
              .trim()
              .slice(0, 60)
          : browserNameFromUserAgent(input.userAgent)
      const collect = `secollect_${randomBytes(32).toString('base64url')}`
      const at = now()
      const request: PairRequest = {
        requestId: randomUUID(),
        name,
        route: input.route,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + PAIR_REQUEST_TTL_MS).toISOString(),
        expiresAtMs: at + PAIR_REQUEST_TTL_MS,
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        collectHash: hashSecret(collect),
        tries: 0,
        state: 'pending',
        userAgent: input.userAgent,
      }
      requests = [...requests, request]
      changed()
      return { ok: true, requestId: request.requestId, code: request.code, collect, expiresAt: request.expiresAt }
    },
    pending() {
      prune()
      return requests.filter((request) => request.state === 'pending').map(view)
    },
    approve(requestId, code) {
      prune()
      const request = requests.find((entry) => entry.requestId === requestId && entry.state === 'pending')
      if (!request) return { ok: false, message: 'That request has gone: it was answered, or it expired.' }
      if (!secretsMatch(request.code, code.trim())) {
        request.tries++
        if (request.tries >= MAX_TRIES) {
          request.state = 'declined'
          changed()
          return { ok: false, message: 'Three wrong codes: the request was declined.' }
        }
        return { ok: false, message: 'That is not the code the browser shows.' }
      }
      request.state = 'approved'
      changed()
      return { ok: true }
    },
    decline(requestId) {
      const request = requests.find((entry) => entry.requestId === requestId && entry.state === 'pending')
      if (!request) return false
      request.state = 'declined'
      changed()
      return true
    },
    collect(requestId, collect) {
      const request = requests.find((entry) => entry.requestId === requestId)
      if (!request || !secretsMatch(request.collectHash, hashSecret(collect))) return { status: 'expired' }
      if (request.expiresAtMs <= now()) {
        prune()
        return { status: 'expired' }
      }
      if (request.state === 'pending') return { status: 'pending' }
      // Answered once either way: the request is gone after this poll.
      requests = requests.filter((entry) => entry !== request)
      changed()
      if (request.state === 'declined') return { status: 'declined' }
      const issued = options.sessions.issue({ userAgent: request.userAgent, name: request.name, route: request.route })
      return issued.ok
        ? { status: 'approved', session: issued.session, secret: issued.secret }
        : { status: 'failed', message: issued.message }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
