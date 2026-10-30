import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { normalizeOrigin } from '../../server/web/web-origins'
import type { McpHttpClientView } from '../../shared/mcp-http'
import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import {
  createMcpDispatcher,
  declaredProtocolVersion,
  isRecord,
  jsonRpcErrorResponse,
  jsonRpcIdOf,
  unsupportedProtocolVersionMessage,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  type McpClientToolHooks,
  type McpToolCallEvent,
} from './mcp-dispatch'

// The Studio MCP gateway over loopback HTTP, for an MCP client that takes a
// URL rather than a command (MCP's streamable HTTP transport). The same
// dispatcher as the local socket and the tailnet listener (mcp-dispatch.ts),
// so the tools, their versions and their audit are the socket's; what this
// file adds is the door.
//
// - It binds 127.0.0.1 alone: nothing off this machine reaches it.
// - Every request carries a bearer token the person made in Settings for one
//   client (mcp-http-tokens.ts). A caller is the person's own tool, so it is
//   served as the socket serves an outside client (`external-local`), never
//   as one of Studio's agents.
// - What is left on this machine is every page in the person's browser. A
//   page cannot set an `Authorization` header on a request it has no token
//   for, and two checks hold it off besides, as the web listener's do
//   (web-origins.ts): `Host` must name this listener, so a hostile name that
//   resolves to 127.0.0.1 (DNS rebinding) is refused before anything is read;
//   and an `Origin`, when one is sent, must be a loopback one.
// - A request body is at most 1 MiB, as the socket's line and the tailnet's
//   body are.
//
// Responses are plain JSON, which the transport allows for every request; the
// server opens no event stream, so a GET is refused (405) as the transport
// says a server without one answers. A session is kept when `initialize`
// starts one, so a client's `notifications/cancelled` finds the call it names.

export const MCP_HTTP_PATH = '/mcp'
export const MAX_MCP_HTTP_BODY_BYTES = 1024 * 1024
const SESSION_HEADER = 'mcp-session-id'
const MAX_SESSIONS = 64
const SESSION_IDLE_MS = 60 * 60_000
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CONNECT_METHOD = 'sprintengine.studio/connect'

export type McpHttpServerOptions = {
  serverName: string
  serverVersion: string
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  clientTools?: McpClientToolHooks
  /** The client a bearer token belongs to, or null. Asked at each request, so a revoked token stops at once. */
  authenticate: (token: string) => McpHttpClientView | null
  onToolCall?: (event: McpToolCallEvent) => void
  log?: (message: string) => void
  now?: () => number
}

export type McpHttpServer = {
  /** Listen on `port`, or on one the system picks when it is null or taken; answers the port bound. */
  start(port: number | null): Promise<number>
  stop(): Promise<void>
  isRunning(): boolean
  port(): number | null
  /** Forget the sessions a revoked client held. */
  dropClient(clientId: string): void
}

type Session = { clientId: string; context: McpConnectionContext; lastUsedAt: number }

export function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer {
  const now = options.now ?? Date.now
  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    ...(options.clientTools ? { clientTools: options.clientTools } : {}),
    onToolCall: options.onToolCall,
  })
  const sessions = new Map<string, Session>()
  let server: Server | null = null
  let boundPort: number | null = null

  function pruneSessions(): void {
    const cutoff = now() - SESSION_IDLE_MS
    for (const [id, session] of sessions) if (session.lastUsedAt < cutoff) sessions.delete(id)
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const gate = gateRequest(request, boundPort)
    if (gate) return writeJson(response, gate.status, { error: { code: gate.code, message: gate.message } })
    const path = (request.url ?? '').split('?')[0]
    if (path !== MCP_HTTP_PATH)
      return writeJson(response, 404, {
        error: { code: 'not_found', message: `The MCP endpoint is ${MCP_HTTP_PATH}.` },
      })
    const client = bearerOf(request)
    const authenticated = client ? options.authenticate(client) : null
    if (!authenticated) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      return writeJson(response, 401, {
        error: { code: 'unauthorized', message: 'A bearer token from Studio Settings ▸ MCPs is required.' },
      })
    }
    const sessionId = headerOf(request, SESSION_HEADER)
    if (request.method === 'DELETE') {
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (session?.clientId === authenticated.id) sessions.delete(sessionId!)
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, DELETE')
      return writeJson(response, 405, {
        error: { code: 'method_not_allowed', message: 'This endpoint answers POSTed JSON-RPC and opens no stream.' },
      })
    }
    if (!/^application\/json\b/iu.test(headerOf(request, 'content-type') ?? ''))
      return writeJson(response, 415, { error: { code: 'unsupported_media_type', message: 'Send application/json.' } })
    const body = await readJsonBody(request, response)
    if (body === undefined) return
    if (Array.isArray(body))
      return writeJson(
        response,
        400,
        jsonRpcErrorResponse(null, JSONRPC_INVALID_REQUEST, 'Batched JSON-RPC is not taken; send one message.'),
      )
    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return writeJson(
        response,
        400,
        jsonRpcErrorResponse(jsonRpcIdOf(body), JSONRPC_INVALID_REQUEST, 'Request is not a JSON-RPC 2.0 message.'),
      )
    const id = jsonRpcIdOf(body)
    const isNotification = id === null && !('id' in body)
    const params = isRecord(body.params) ? body.params : {}

    // A session named must be one this client holds; one gone (idle, or the
    // app restarted) is a 404, which tells the client to initialize again.
    let session: Session | undefined
    if (sessionId) {
      session = sessions.get(sessionId)
      if (!session || session.clientId !== authenticated.id)
        return writeJson(response, 404, { error: { code: 'unknown_session', message: 'Initialize a new session.' } })
      session.lastUsedAt = now()
    }
    const context: McpConnectionContext = session?.context ?? { metadata: { kind: 'external-local' } }
    if (body.method === 'initialize' && !session) {
      pruneSessions()
      const minted = randomUUID()
      sessions.set(minted, { clientId: authenticated.id, context, lastUsedAt: now() })
      response.setHeader('Mcp-Session-Id', minted)
    }
    // An outside client is the person's own tool; declaring itself one of
    // Studio's agents here would be a claim with nothing behind it.
    if (body.method === CONNECT_METHOD)
      return writeJson(
        response,
        400,
        jsonRpcErrorResponse(
          id,
          JSONRPC_INVALID_REQUEST,
          `${CONNECT_METHOD} is for Studio's own agents, on its socket.`,
        ),
      )
    const declared = declaredProtocolVersion(params, headerOf(request, 'mcp-protocol-version'))
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      return writeJson(response, 400, jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail))
    }
    try {
      const outcome = await dispatcher.dispatch(body.method, params, context, undefined, { requestId: id })
      if (isNotification) {
        response.writeHead(202).end()
        return
      }
      if (outcome.kind === 'no_response') return writeJson(response, 200, { jsonrpc: '2.0', id, result: {} })
      if (outcome.kind === 'error')
        return writeJson(response, 200, jsonRpcErrorResponse(id, outcome.code, outcome.errorMessage))
      return writeJson(response, 200, { jsonrpc: '2.0', id, result: outcome.value })
    } catch (error) {
      options.log?.(`MCP HTTP dispatch threw: ${errorText(error)}`)
      if (isNotification) {
        response.writeHead(202).end()
        return
      }
      return writeJson(
        response,
        200,
        jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${errorText(error)}`),
      )
    }
  }

  function listen(port: number): Promise<Server> {
    const next = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        options.log?.(`MCP HTTP request failed: ${errorText(error)}`)
        if (!response.headersSent) writeJson(response, 500, { error: { code: 'internal', message: 'Request failed.' } })
      })
    })
    return new Promise((resolve, reject) => {
      next.once('error', reject)
      next.listen(port, '127.0.0.1', () => {
        next.removeListener('error', reject)
        resolve(next)
      })
    })
  }

  return {
    async start(port) {
      if (server && boundPort !== null) return boundPort
      let next: Server
      try {
        next = await listen(port ?? 0)
      } catch (error) {
        // The port it had is taken now: another, and the URL changes with it.
        if (port === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        options.log?.(`MCP HTTP port ${port} is taken; listening on another`)
        next = await listen(0)
      }
      const address = next.address()
      server = next
      boundPort = address && typeof address === 'object' ? address.port : null
      return boundPort!
    },
    async stop() {
      const current = server
      server = null
      boundPort = null
      sessions.clear()
      if (!current) return
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        current.closeAllConnections?.()
      })
    },
    isRunning: () => server !== null,
    port: () => boundPort,
    dropClient(clientId) {
      for (const [id, session] of sessions) if (session.clientId === clientId) sessions.delete(id)
    },
  }
}

/** Why a request is refused before anything else is read, or null: its `Host` and `Origin`. */
export function gateRequest(
  request: Pick<IncomingMessage, 'headers'>,
  port: number | null,
): { status: number; code: string; message: string } | null {
  const host = headerOf(request, 'host')?.toLowerCase()
  const hostAllowed =
    port !== null && host !== undefined && [...LOOPBACK_HOSTNAMES].some((name) => host === `${name}:${port}`)
  if (!hostAllowed) return { status: 421, code: 'host_not_allowed', message: 'Address this server as 127.0.0.1.' }
  const origin = headerOf(request, 'origin')
  if (origin === undefined) return null
  const normalized = normalizeOrigin(origin)
  const originHost = normalized ? new URL(normalized).hostname : null
  if (!originHost || !LOOPBACK_HOSTNAMES.has(originHost.startsWith('[') ? originHost : originHost.toLowerCase()))
    return { status: 403, code: 'origin_not_allowed', message: 'Only a page on this machine may call this server.' }
  return null
}

function headerOf(request: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function bearerOf(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/iu.exec(headerOf(request, 'authorization') ?? '')
  return match ? match[1]! : null
}

async function readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | undefined> {
  const declared = Number(headerOf(request, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_MCP_HTTP_BODY_BYTES) {
    writeJson(response, 413, tooLarge())
    request.resume()
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_MCP_HTTP_BODY_BYTES) {
        writeJson(response, 413, tooLarge())
        await new Promise<void>((resolve) => {
          response.once('finish', resolve)
          response.once('close', resolve)
        })
        return undefined
      }
      chunks.push(buffer)
    }
  } catch (error) {
    writeJson(response, 400, { error: { code: 'body_read_failed', message: errorText(error) } })
    return undefined
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    writeJson(response, 400, jsonRpcErrorResponse(null, -32700, 'Request is not valid JSON.'))
    return undefined
  }
}

function tooLarge(): Record<string, unknown> {
  return {
    error: { code: 'body_too_large', message: `Request body exceeds the ${MAX_MCP_HTTP_BODY_BYTES}-byte limit.` },
  }
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (response.headersSent) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
