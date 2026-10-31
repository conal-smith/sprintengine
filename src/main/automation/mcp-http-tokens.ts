import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { isRecord } from '../../shared/records'
import { MCP_HTTP_CLIENT_NAME_MAX, MCP_HTTP_MAX_CLIENTS, type McpHttpClientView } from '../../shared/mcp-http'
import { writeFileAtomically } from '../config-file-write'
import { hashSecret, secretsMatch } from './tailnet/secret-hash'

// The bearer tokens the loopback HTTP endpoint takes, one per client the
// person made one for, and the port it listens on.
//
// A token is kept only as its SHA-256 digest, as a paired device's is
// (secret-hash.ts): the file names who may connect, and reading it hands
// nobody a credential. A token is 32 random bytes, so a digest of it cannot be
// guessed back. The port is kept beside them so the URL a client was given
// stays the same from one start to the next.

export const MCP_HTTP_FILE = 'mcp-http.json'
const FORMAT_VERSION = 1
const TOKEN_PREFIX = 'semcp_'
/** A use is written down at most this often: a client calls many times a minute. */
const TOUCH_PERSIST_MS = 60_000

type StoredClient = { id: string; name: string; hash: string; createdAt: number; lastUsedAt: number | null }

export type McpHttpTokenStore = {
  list(): McpHttpClientView[]
  /** Make a token for a client; the token is in the clear in this answer alone. */
  create(name: string): { ok: true; client: McpHttpClientView; token: string } | { ok: false; message: string }
  /** Whether a client was revoked. */
  revoke(id: string): boolean
  /** The client a presented token belongs to, or null; a match is recorded as a use. */
  authenticate(token: string): McpHttpClientView | null
  port(): number | null
  setPort(port: number): void
  /** Let the last write land. */
  flush(): Promise<void>
}

function parseClient(value: unknown): StoredClient | null {
  if (!isRecord(value)) return null
  const { id, name, hash, createdAt, lastUsedAt } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash))
    return null
  if (typeof createdAt !== 'number') return null
  return { id, name, hash, createdAt, lastUsedAt: typeof lastUsedAt === 'number' ? lastUsedAt : null }
}

const view = ({ id, name, createdAt, lastUsedAt }: StoredClient): McpHttpClientView => ({
  id,
  name,
  createdAt,
  lastUsedAt,
})

export function createMcpHttpTokenStore(options: {
  file: string
  now?: () => number
  write?: (path: string, body: string) => Promise<void>
  log?: (message: string) => void
}): McpHttpTokenStore {
  const now = options.now ?? Date.now
  const write = options.write ?? writeFileAtomically
  let clients: StoredClient[] = []
  let port: number | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(options.file, 'utf8'))
    if (isRecord(parsed)) {
      clients = (Array.isArray(parsed.clients) ? parsed.clients : []).flatMap((entry) => parseClient(entry) ?? [])
      if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536)
        port = parsed.port
    }
  } catch {
    // No file yet, or one that cannot be read: no tokens, and a port of the system's choosing.
  }

  let writing: Promise<void> = Promise.resolve()
  let lastTouchWrite = 0
  const persist = () => {
    const body = `${JSON.stringify({ version: FORMAT_VERSION, port, clients }, null, 2)}\n`
    writing = writing
      .then(() => write(options.file, body))
      .catch((error: unknown) =>
        options.log?.(`MCP HTTP tokens were not saved: ${error instanceof Error ? error.message : String(error)}`),
      )
  }

  return {
    list: () => clients.map(view),
    create(rawName) {
      const name = rawName.trim().replace(/\s+/gu, ' ')
      if (!name) return { ok: false, message: 'Name the client the token is for.' }
      if (name.length > MCP_HTTP_CLIENT_NAME_MAX)
        return { ok: false, message: `A name is at most ${MCP_HTTP_CLIENT_NAME_MAX} characters.` }
      if (clients.length >= MCP_HTTP_MAX_CLIENTS)
        return { ok: false, message: `At most ${MCP_HTTP_MAX_CLIENTS} tokens; revoke one first.` }
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      const client: StoredClient = {
        id: randomUUID(),
        name,
        hash: hashSecret(token),
        createdAt: now(),
        lastUsedAt: null,
      }
      clients = [...clients, client]
      persist()
      return { ok: true, client: view(client), token }
    },
    revoke(id) {
      const before = clients.length
      clients = clients.filter((client) => client.id !== id)
      if (clients.length === before) return false
      persist()
      return true
    },
    authenticate(token) {
      if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null
      const hash = hashSecret(token)
      const client = clients.find((candidate) => secretsMatch(candidate.hash, hash))
      if (!client) return null
      const at = now()
      client.lastUsedAt = at
      if (at - lastTouchWrite >= TOUCH_PERSIST_MS) {
        lastTouchWrite = at
        persist()
      }
      return view(client)
    },
    port: () => port,
    setPort(next) {
      if (next === port) return
      port = next
      persist()
    },
    flush: () => writing,
  }
}
