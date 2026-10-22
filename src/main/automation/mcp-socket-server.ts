import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, unlinkSync } from 'fs'

import { withOwnerOnlyUmask } from '../private-socket-dir'

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
  JSONRPC_PARSE_ERROR,
  type JsonRpcId,
  type McpClientToolHooks,
  type McpToolCallEvent,
} from './mcp-dispatch'
import type {
  McpConnectionContext,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
} from '../../shared/modules/mcp-tools'

// Minimal MCP server over a local socket: newline-delimited JSON-RPC 2.0 —
// the same framing as MCP's stdio transport, carried on a Unix domain socket
// (POSIX) or named pipe (Windows) so access is gated by filesystem permissions
// and no remote binding is possible. It implements only the few methods the
// automation surface needs — initialize, tools/list, tools/call, ping — without
// adding an SDK dependency.
//
// The MCP semantics themselves live in mcp-dispatch.ts, shared with the opt-in
// tailnet HTTP/WS listener (tailnet/tailnet-gateway-server.ts). This file owns
// framing and connection lifetime only. Filesystem permissions remain the
// entire authentication model HERE — the tailnet transport is separate, opt-in,
// and carries its own device-token auth.

// One inbound frame may not exceed this; a client that streams an unbounded
// line gets an explicit error and a closed connection, never silent buffering.
const MAX_LINE_BYTES = 1024 * 1024

// Canonical MCP tool/connection shapes moved to src/shared/modules/mcp-tools
// so the module host and SDK can share them; re-exported here for
// the automation-surface importers.
export type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration, McpToolResult }

export type McpSocketServerOptions = {
  socketPath: string
  serverName: string
  serverVersion: string
  /**
   * The current tool set, evaluated on every tools/list and tools/call rather
   * than captured at construction: module-contributed tools follow module
   * enablement live, and the gateway is constructed before modules
   * load, so a snapshot here would be permanently stale.
   */
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  /**
   * Client tools: each connection's own catalog, told when it grows. A
   * connection is tracked while it is open, and told alone.
   */
  clientTools?: McpClientToolHooks & { track(context: McpConnectionContext, notify: () => void): () => void }
  onToolCall?: (event: McpToolCallEvent) => void
  log?: (message: string) => void
  /**
   * Whether this process may remove a socket file it finds at start: true only
   * for the holder of the data directory's run lock (or a desktop, which its
   * single-instance lock already makes the only owner). Asked at each start;
   * absent means yes, as for a test's own socket.
   */
  mayRemoveStaleSocket?: () => boolean
}

export type McpSocketServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** Tell every connected client the tool set changed (module enable/disable). */
  notifyToolsListChanged(): void
}

export function createMcpSocketServer(options: McpSocketServerOptions): McpSocketServer {
  let server: Server | null = null
  const sockets = new Set<Socket>()
  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    ...(options.clientTools ? { clientTools: options.clientTools } : {}),
    onToolCall: options.onToolCall,
  })

  async function start(): Promise<void> {
    if (server) return
    // A stale socket file from a crashed previous run would block listen();
    // remove it. Only the run lock's holder may: whoever else is listening on
    // this path holds the lock, so a process without it would disconnect a
    // live server's agents. Without it, the listen below fails and the status
    // says why instead.
    if (process.platform !== 'win32' && existsSync(options.socketPath)) {
      if (options.mayRemoveStaleSocket?.() ?? true) unlinkSync(options.socketPath)
      else options.log?.(`${options.socketPath} exists and this process does not hold the run lock; leaving it`)
    }
    const next = createServer((socket) => handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        next.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        next.removeListener('error', onError)
        resolve()
      }
      next.once('error', onError)
      next.once('listening', onListening)
      // Created owner-only, not narrowed after the fact.
      if (process.platform === 'win32') next.listen(options.socketPath)
      else withOwnerOnlyUmask(() => next.listen(options.socketPath))
    })
    if (process.platform !== 'win32') {
      // Owner-only access; the socket is the entire authentication model.
      chmodSync(options.socketPath, 0o600)
    }
    next.on('error', (error) => options.log?.(`automation socket server error: ${error.message}`))
    server = next
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    for (const untrack of untracks.values()) untrack()
    untracks.clear()
    connectionContexts.clear()
    await new Promise<void>((resolve) => current.close(() => resolve()))
    if (process.platform !== 'win32' && existsSync(options.socketPath)) {
      try {
        unlinkSync(options.socketPath)
      } catch (error) {
        options.log?.(`automation socket cleanup failed: ${message(error)}`)
      }
    }
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    const context: McpConnectionContext = { metadata: { kind: 'external-local' } }
    connectionContexts.set(socket, context)
    if (options.clientTools)
      untracks.set(
        socket,
        options.clientTools.track(context, () =>
          respond(socket, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
        ),
      )
    // Preserve request ordering within one stdio bridge. In particular, the
    // bridge's advisory connection-metadata notification must be applied before
    // an immediately-following initialize/tools call on the same TCP chunk.
    let pending = Promise.resolve()
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        respond(
          socket,
          jsonRpcErrorResponse(null, JSONRPC_INVALID_REQUEST, 'Request frame exceeds the 1 MiB line limit.'),
        )
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        // A cancellation is about a call that is still running, which the
        // queue would make it wait behind: it is handled as it arrives.
        if (line && isCancellation(line)) void handleLine(socket, line)
        else if (line) pending = pending.then(() => handleLine(socket, line))
        newline = buffer.indexOf('\n')
      }
    })
    const forget = () => {
      sockets.delete(socket)
      connectionContexts.delete(socket)
      untracks.get(socket)?.()
      untracks.delete(socket)
    }
    socket.on('close', forget)
    socket.on('error', forget)
  }

  async function handleLine(socket: Socket, line: string): Promise<void> {
    // A line queued behind a slow call outlives its socket. Its context went
    // with the socket, and running it under a fresh one would be a stranger's.
    const context = connectionContexts.get(socket)
    if (!context || socket.destroyed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      respond(socket, jsonRpcErrorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      respond(
        socket,
        jsonRpcErrorResponse(idOf(parsed), JSONRPC_INVALID_REQUEST, 'Request is not a JSON-RPC 2.0 message.'),
      )
      return
    }
    const id = idOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}

    // This transport carries no headers, so `params._meta` is the whole of the
    // per-request version channel. The accepted value is validated and
    // discarded: no behaviour here varies by version, so remembering it per
    // connection would be state nobody reads.
    const declared = declaredProtocolVersion(params)
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      // A notification cannot be answered; dropping it unlogged would be the silent
      // fallback the norms forbid, so the refusal goes to the log instead.
      if (isNotification) options.log?.(`automation socket refused ${parsed.method}: ${detail}`)
      else respond(socket, jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail))
      return
    }

    try {
      const result = await dispatcher.dispatch(parsed.method, params, context, undefined, {
        requestId: id,
        notify: (message) => respond(socket, message),
      })
      if (result.kind === 'no_response') {
        if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: {} })
        return
      }
      if (result.kind === 'error') {
        // A refused identity re-declaration is a notification with nobody to
        // answer, so it is logged rather than dropped without a trace. Other
        // notifications this server does not implement stay quiet: clients send
        // them routinely.
        if (!isNotification) respond(socket, jsonRpcErrorResponse(id, result.code, result.errorMessage))
        else if (parsed.method === 'sprintengine.studio/connect') {
          options.log?.(`automation socket refused ${parsed.method}: ${result.errorMessage}`)
        }
        return
      }
      if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: result.value })
    } catch (error) {
      options.log?.(`automation tool dispatch threw: ${message(error)}`)
      if (!isNotification) {
        respond(socket, jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`))
      }
    }
  }

  const connectionContexts = new Map<Socket, McpConnectionContext>()
  const untracks = new Map<Socket, () => void>()

  return {
    start,
    stop,
    isRunning: () => server !== null,
    notifyToolsListChanged: () => {
      for (const socket of sockets) {
        respond(socket, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
    },
  }
}

function respond(socket: Socket, payload: Record<string, unknown>): void {
  if (socket.destroyed) return
  let line = JSON.stringify(payload)
  // The cap is the wire's, in both directions: a result too large for one
  // line becomes an explicit tool error rather than a frame a bridge or a
  // tailnet peer refuses and drops the connection over.
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && 'id' in payload) {
    const message = `The result was too large to send (${Buffer.byteLength(line, 'utf8')} bytes; the limit is ${MAX_LINE_BYTES}). Ask for less.`
    const structured = { error: { code: 'result_too_large', message } }
    line = JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
        isError: true,
      },
    })
  }
  socket.write(`${line}\n`)
}

/** Whether a line is an agent's `notifications/cancelled`, read cheaply before it is parsed for real. */
function isCancellation(line: string): boolean {
  if (!line.includes('notifications/cancelled')) return false
  try {
    const parsed = JSON.parse(line) as { method?: unknown; id?: unknown }
    return parsed.method === 'notifications/cancelled' && parsed.id === undefined
  } catch {
    return false
  }
}

function idOf(value: unknown): JsonRpcId {
  return jsonRpcIdOf(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
