import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import { connect, type Socket } from 'net'

import {
  isTailnetScope,
  type TailnetPairRequestOutcome,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import {
  checkTailnetTransportVersion,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_CONVERSATION_PATH,
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_CONVERSATION_FILES_PATH,
  TAILNET_CONVERSATION_COMMANDS_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_UPLOAD_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import {
  CONVERSATION_IMAGE_MAX_BYTES,
  sniffConversationImage,
  type ConversationImageMediaType,
} from './tailnet-conversation-images'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeMaskedCloseFrame,
  encodeMaskedPongFrame,
  encodeMaskedTextFrame,
  enableTcpKeepAlive,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_NORMAL,
} from './websocket-frames'
import { asRecord } from '../../../shared/records'

// The outbound client for tailnet remote control: the half that DIALS
// another machine's listener. Everything else under `tailnet/` answers calls;
// this places them.
//
// It lives in the main process, and not because that is convenient: the
// listener refuses any request carrying an `Origin` header, which a renderer's
// fetch and WebSocket both always send. The device token belongs here for the
// same kind of reason — a credential handed to a window is a credential one
// renderer bug away from the tailnet.
//
// Deliberately the same wire the stdio bridge speaks (`resources/automation/
// mcp-stdio-bridge.mjs`), because it IS the same protocol; the bridge cannot be
// imported (it is a dependency-free script for machines with no Studio at all)
// but the framing here is the app's own codec rather than a third copy.

/** A wrong port that accepts TCP and then says nothing must not hang the UI behind it. */
const REQUEST_TIMEOUT_MS = 10_000
/** One image going up to the upload route; see `uploadRemoteConversationImage`. */
const UPLOAD_TIMEOUT_MS = 60_000
/** One file going up, which may be five times a picture's ceiling. */
const FILE_UPLOAD_TIMEOUT_MS = 5 * 60_000
/** The upgrade handshake only. A change feed is idle most of its life and is never timed out. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Enough for any control response; a body larger than this is not our listener answering. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** Silence on a conversation socket longer than two of the far end's 25-second pings means the link is gone. */
const CONVERSATION_LIVENESS_TIMEOUT_MS = 70_000

export type TailnetEndpoint = { host: string; port: number }

export type RemoteCallOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

/**
 * Split `host:port` — including the `[v6]:port` form the listener publishes.
 *
 * Returns null rather than guessing a port: an endpoint we cannot read is one we
 * must not dial, because the guess would be a request to somewhere nobody chose.
 */
export function parseTailnetEndpoint(value: string): TailnetEndpoint | null {
  const trimmed = value.trim()
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed)
  if (bracketed) {
    const port = Number(bracketed[2])
    return isPort(port) ? { host: bracketed[1], port } : null
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return null
  const host = trimmed.slice(0, separator)
  const port = Number(trimmed.slice(separator + 1))
  // An unbracketed colon in the host means a bare IPv6 literal, which is
  // ambiguous with the port separator; refuse it rather than truncate an address.
  if (!host || host.includes(':') || !isPort(port)) return null
  return { host, port }
}

export function formatTailnetEndpoint(endpoint: TailnetEndpoint): string {
  return endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
}

/** A `sprintengine-tailnet://pair?…` link, as the other machine's Settings shows it. */
export function parsePairingUrl(value: string): { endpoint: TailnetEndpoint; pairingToken: string } | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'sprintengine-tailnet:') return null
  const endpointValue = url.searchParams.get('endpoint')
  const pairingToken = url.searchParams.get('token')
  if (!endpointValue || !pairingToken) return null
  const endpoint = parseTailnetEndpoint(endpointValue)
  return endpoint ? { endpoint, pairingToken } : null
}

type JsonAnswer = { status: number; body: unknown }

/** One HTTP round trip to a listener. Never throws for a status; a status is an answer. */
export function requestTailnetJson(input: {
  endpoint: TailnetEndpoint
  method: 'GET' | 'POST'
  path: string
  token?: string
  body?: unknown
  /**
   * A body sent as it is, under its own type, in place of a JSON `body`: an
   * image going up to the upload route. The answer is JSON either way.
   */
  bytes?: { data: Buffer; contentType: string }
  timeoutMs?: number
}): Promise<JsonAnswer> {
  const payload = input.bytes
    ? input.bytes.data
    : input.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(input.body), 'utf8')
  const contentType = input.bytes ? input.bytes.contentType : 'application/json'
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: input.endpoint.host,
        port: input.endpoint.port,
        method: input.method,
        path: input.path,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          // No Origin, ever: the listener refuses any request carrying one, and
          // rightly — see the transport notes in the knowledge graph.
          ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}),
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy()
            reject(new Error('the answer was larger than this transport carries'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {
            body = null
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
        response.on('error', reject)
      },
    )
    call.on('error', reject)
    call.setTimeout(timeoutMs, () => {
      call.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`))
    })
    if (payload) call.write(payload)
    call.end()
  })
}

/** Redeem a one-time pairing code for a device token this machine can keep. */
export async function pairWithMachine(input: {
  endpoint: TailnetEndpoint
  pairingToken: string
  deviceName: string
}): Promise<RemoteCallOutcome<{ deviceId: string; deviceName: string; deviceToken: string; scopes: TailnetScope[] }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_PATH,
      body: { pairingToken: input.pairingToken, deviceName: input.deviceName },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.deviceToken !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words. A pairing refusal is the one moment a
      // person needs the exact reason — expired, already spent, wrong code.
      message: typeof error?.message === 'string' ? error.message : `Pairing was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : input.deviceName,
      deviceToken: record.deviceToken,
      scopes: readScopes(record.scopes),
    },
  }
}

/**
 * Ask a machine to pair, for someone there to approve.
 *
 * Only the HASH of the collect secret goes over the wire; the secret itself
 * stays here and is presented to collect. The answer carries the comparison
 * code so this machine can show the same six digits the other one is showing.
 */
export async function requestPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  deviceName: string
  collectHash: string
  /**
   * What this machine asks to be allowed to do there. Omitted rather than
   * defaulted when the caller names nothing: the far end owns that default, and
   * sending our idea of it would make an older listener and a newer one
   * disagree about a set neither of us chose.
   */
  scopes?: readonly TailnetScope[]
}): Promise<RemoteCallOutcome<{ requestId: string; comparisonCode: string; expiresAt: string }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_REQUEST_PATH,
      body: {
        deviceName: input.deviceName,
        collectHash: input.collectHash,
        ...(input.scopes ? { scopes: [...input.scopes] } : {}),
      },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.requestId !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words again — "there is already a request
      // waiting there" is the one thing a person needs to hear verbatim.
      message: typeof error?.message === 'string' ? error.message : `The request was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      requestId: record.requestId,
      comparisonCode: typeof record.comparisonCode === 'string' ? record.comparisonCode : '',
      expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : '',
    },
  }
}

/**
 * Poll a request we made. The device token comes back to exactly one call.
 *
 * A POST with a body rather than the original GET (phase 6): when this
 * machine offered the other one a device here, `reverse` rides on the poll,
 * and the approver's listener stores it in the same exchange that hands our
 * token over. Sent on every poll rather than only the last, because there is
 * no way to know which poll will be the one that finds the approval.
 */
export async function collectPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  requestId: string
  collectSecret: string
  reverse?: TailnetReverseGrant | null
}): Promise<RemoteCallOutcome<TailnetPairRequestOutcome>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_COLLECT_PATH,
      body: {
        id: input.requestId,
        secret: input.collectSecret,
        ...(input.reverse ? { reverse: input.reverse } : {}),
      },
    })
  } catch (error) {
    // A machine that has gone to sleep mid-wait is not a refusal: the caller
    // keeps polling rather than tearing the request down.
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  const status = typeof record?.status === 'string' ? record.status : ''
  if (answer.status !== 200 || !status) {
    return { ok: false, code: `http_${answer.status}`, message: `The machine answered oddly (HTTP ${answer.status}).` }
  }
  if (status === 'approved') {
    return {
      ok: true,
      value: {
        status: 'approved',
        deviceId: typeof record?.deviceId === 'string' ? record.deviceId : '',
        deviceName: typeof record?.deviceName === 'string' ? record.deviceName : '',
        deviceToken: typeof record?.deviceToken === 'string' ? record.deviceToken : '',
        scopes: readScopes(record?.scopes),
      },
    }
  }
  if (status === 'pending') {
    return {
      ok: true,
      value: {
        status: 'pending',
        comparisonCode: typeof record?.comparisonCode === 'string' ? record.comparisonCode : '',
        expiresAt: typeof record?.expiresAt === 'string' ? record.expiresAt : '',
      },
    }
  }
  return { ok: true, value: { status: status === 'denied' ? 'denied' : 'expired' } }
}

/** What one authenticated handshake with a machine established. */
export type RemoteIdentity = {
  deviceId: string
  deviceName: string
  scopes: TailnetScope[]
  /** The wire that machine speaks; always inside this build's window, or the call refused. */
  transportVersion: number
  /**
   * What that machine says it can do, in its own words. Ask this before using
   * anything the transport did not always have, rather than inferring it from
   * `transportVersion` — see `tailnetPeerSupports`.
   *
   * Null when the peer published no list at all, which is not the same fact as
   * an empty one and must not be flattened into it: an empty list is a machine
   * saying it can do nothing, null is a machine that was never asked the
   * question. Builds from the day between the change feed shipping and the
   * capability list being advertised are exactly that, and a caller that reads
   * their silence as a denial would switch off a feature they serve.
   */
  capabilities: string[] | null
}

/**
 * What the remote says our device is and may do, right now.
 *
 * This is the handshake, and so it is where the transport version is enforced
 * (the first version shipped without that check, and a mismatched peer then failed later
 * on a payload shape instead). A machine outside the window is refused here
 * with a named code, so the Mesh records it as unreachable-with-a-reason
 * rather than as a machine that answered and then behaved oddly.
 *
 * `timeoutMs` is for the reachability check (phase 4), which asks this of
 * every paired machine on a timer: a sleeping laptop should cost a few
 * seconds per interval, not the ten a person-driven browse can afford.
 */
export async function readRemoteIdentity(input: {
  endpoint: TailnetEndpoint
  token: string
  timeoutMs?: number
}): Promise<RemoteCallOutcome<RemoteIdentity>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'GET',
      path: TAILNET_IDENTITY_PATH,
      token: input.token,
      timeoutMs: input.timeoutMs,
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || !record) {
    return { ok: false, code: `http_${answer.status}`, message: `That machine answered HTTP ${answer.status}.` }
  }
  const refusal = checkTailnetTransportVersion(record.transportVersion)
  if (refusal) return { ok: false, code: refusal.code, message: refusal.message }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : '',
      scopes: readScopes(record.scopes),
      transportVersion: record.transportVersion as number,
      capabilities: readCapabilities(record.capabilities),
    },
  }
}

/**
 * The capability list out of a handshake, or null when the peer named none.
 *
 * Anything that is not a string is dropped, but the list is not filtered
 * against our own: a peer may publish names this build has never heard of, and
 * the list is only ever asked "is X in here".
 */
function readCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.slice(0, 64))
}

/**
 * Call one gateway tool on the remote machine.
 *
 * Over the stateless POST endpoint rather than the WebSocket: these are
 * one-shot reads for a panel, they carry no connection-scoped declaration, and
 * holding a socket open per browse would be a socket per machine for a list
 * somebody glanced at.
 *
 * A tool that refuses (out of scope, unknown workspace) comes back as
 * `{ok:false}` with the tool's own code — never as an empty success.
 */
export async function callRemoteTool(input: {
  endpoint: TailnetEndpoint
  token: string
  tool: string
  args?: Record<string, unknown>
  timeoutMs?: number
}): Promise<RemoteCallOutcome<Record<string, unknown>>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_MCP_PATH,
      token: input.token,
      timeoutMs: input.timeoutMs,
      body: {
        jsonrpc: '2.0',
        id: `mesh-${randomBytes(6).toString('hex')}`,
        method: 'tools/call',
        params: { name: input.tool, arguments: input.args ?? {} },
      },
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const envelope = asRecord(answer.body)
  if (answer.status !== 200 || !envelope) {
    return { ok: false, code: `http_${answer.status}`, message: `"${input.tool}" answered HTTP ${answer.status}.` }
  }
  const rpcError = asRecord(envelope.error)
  if (rpcError) {
    return {
      ok: false,
      code: 'rpc_error',
      message: typeof rpcError.message === 'string' ? rpcError.message : `"${input.tool}" failed on that machine.`,
    }
  }
  const result = asRecord(envelope.result)
  const structured = asRecord(result?.structuredContent)
  if (!structured) {
    return {
      ok: false,
      code: 'unreadable_result',
      message: `"${input.tool}" answered in a shape this build cannot read.`,
    }
  }
  if (result?.isError === true || structured.ok === false) {
    const failure = asRecord(structured.error)
    return {
      ok: false,
      code: typeof failure?.code === 'string' ? failure.code : 'tool_error',
      message: typeof failure?.message === 'string' ? failure.message : `"${input.tool}" was refused by that machine.`,
    }
  }
  return { ok: true, value: structured }
}

/**
 * The picture one step of a chat on another machine made or looked at, as that
 * machine serves it (`conversation-images`).
 *
 * Bounded by the same ceiling the far end serves under, whatever it says it
 * is sending: a body that runs past it is cut off, not buffered. The type is
 * read off the bytes again here rather than taken from the header, so what
 * reaches a window is always one of the four formats.
 */
export function fetchRemoteConversationImage(input: {
  endpoint: TailnetEndpoint
  token: string
  workspaceId: string
  agentId: string
  toolUseId: string
  timeoutMs?: number
  maxBytes?: number
}): Promise<RemoteCallOutcome<{ mediaType: ConversationImageMediaType; bytes: Buffer }>> {
  const maxBytes = input.maxBytes ?? CONVERSATION_IMAGE_MAX_BYTES
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    toolUseId: input.toolUseId,
  })
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: RemoteCallOutcome<{ mediaType: ConversationImageMediaType; bytes: Buffer }>) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const call = httpRequest(
      {
        host: input.endpoint.host,
        port: input.endpoint.port,
        method: 'GET',
        path: `${TAILNET_CONVERSATION_IMAGE_PATH}?${query.toString()}`,
        headers: {
          Accept: 'image/png, image/jpeg, image/webp, image/gif, application/json',
          Connection: 'close',
          Authorization: `Bearer ${input.token}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        const tooLarge = () =>
          settle({
            ok: false,
            code: 'image_too_large',
            message: `That picture is over the ${Math.floor(maxBytes / (1024 * 1024))}MB this app shows.`,
          })
        const declared = Number(response.headers['content-length'] ?? '')
        const limit = status === 200 ? maxBytes : MAX_RESPONSE_BYTES
        if (Number.isFinite(declared) && declared > limit) {
          response.destroy()
          if (status === 200) tooLarge()
          else settle({ ok: false, code: `http_${status}`, message: `That machine answered HTTP ${status}.` })
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > limit) {
            response.destroy()
            if (status === 200) tooLarge()
            else settle({ ok: false, code: `http_${status}`, message: `That machine answered HTTP ${status}.` })
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const body = Buffer.concat(chunks)
          if (status === 200) {
            const mediaType = sniffConversationImage(body.subarray(0, 16))
            if (!mediaType) {
              settle({ ok: false, code: 'not_an_image', message: 'That machine sent something that is not a picture.' })
              return
            }
            settle({ ok: true, value: { mediaType, bytes: body } })
            return
          }
          if (status === 401) {
            settle({ ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE })
            return
          }
          let error: Record<string, unknown> | null = null
          try {
            error = asRecord(asRecord(JSON.parse(body.toString('utf8')))?.error)
          } catch {
            error = null
          }
          settle({
            ok: false,
            code: typeof error?.code === 'string' ? error.code : `http_${status}`,
            message: typeof error?.message === 'string' ? error.message : `That machine answered HTTP ${status}.`,
          })
        })
        response.on('error', (error) =>
          settle({ ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }),
        )
        response.on('close', () => {
          if (!response.complete)
            settle({ ok: false, code: 'unreachable', message: 'That machine stopped sending the picture.' })
        })
      },
    )
    call.on('error', (error) =>
      settle({ ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }),
    )
    call.setTimeout(timeoutMs, () => {
      call.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`))
    })
    call.end()
  })
}

/**
 * An image a person attached to a message on a chat that runs on another
 * machine, put in that machine's upload store (`upload`) for the send that
 * follows to name by the id it answers. The route is the one the phone attaches
 * pictures through, under the same pairing token: the far end keeps an upload
 * for the device that sent it and the chat session it named, and a send from
 * any other device, or for any other chat, cannot spend it.
 *
 * Given longer than a control request: five megabytes over a relayed tailnet
 * path can take well over the ten seconds an answer to a read is allowed.
 */
export async function uploadRemoteConversationImage(input: {
  endpoint: TailnetEndpoint
  token: string
  sessionId: string
  name: string
  mediaType: string
  bytes: Buffer
  /**
   * A file of any type instead of a picture (`conversation-message-files`):
   * kept by that machine where its own uploads are, and attached to the
   * message by its path there.
   */
  kind?: 'file'
  timeoutMs?: number
}): Promise<RemoteCallOutcome<{ uploadId: string }>> {
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    name: input.name,
    ...(input.kind ? { kind: input.kind } : {}),
  })
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: `${TAILNET_UPLOAD_PATH}?${query.toString()}`,
      token: input.token,
      bytes: { data: input.bytes, contentType: input.mediaType },
      timeoutMs: input.timeoutMs ?? (input.kind === 'file' ? FILE_UPLOAD_TIMEOUT_MS : UPLOAD_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const record = asRecord(answer.body)
  if (answer.status === 200 && typeof record?.uploadId === 'string' && record.uploadId)
    return { ok: true, value: { uploadId: record.uploadId } }
  const error = asRecord(record?.error)
  return {
    ok: false,
    code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
    message: typeof error?.message === 'string' ? error.message : `That machine answered HTTP ${answer.status}.`,
  }
}

/**
 * What a paired machine's composer reads of one of its chats, answered in
 * JSON beside its socket: the files a mention may name (`files`, by `query`)
 * or the slash commands the chat's CLI runs (`commands`). The answer is the
 * machine's word, for the caller to read member by member.
 */
export async function readRemoteConversationComposer(input: {
  endpoint: TailnetEndpoint
  token: string
  read: 'files' | 'commands'
  workspaceId: string
  agentId: string
  query?: string
  refresh?: boolean
  timeoutMs?: number
}): Promise<RemoteCallOutcome<unknown>> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.refresh ? { refresh: '1' } : {}),
  })
  const path = input.read === 'files' ? TAILNET_CONVERSATION_FILES_PATH : TAILNET_CONVERSATION_COMMANDS_PATH
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'GET',
      path: `${path}?${query.toString()}`,
      token: input.token,
      timeoutMs: input.timeoutMs,
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  if (answer.status === 200) return { ok: true, value: answer.body }
  const error = asRecord(asRecord(answer.body)?.error)
  return {
    ok: false,
    code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
    message: typeof error?.message === 'string' ? error.message : `That machine answered HTTP ${answer.status}.`,
  }
}

export type RemoteJsonSocket = {
  /** Send one client frame. No-op once closed. */
  send(frame: Record<string, unknown>): void
  /** Close from this end, telling the peer why. */
  close(reason: string): void
  isOpen(): boolean
}

export type RemoteJsonSocketHandlers = {
  /** One decoded server frame, as a plain object. */
  onFrame(frame: Record<string, unknown>): void
  /**
   * The socket is finished. `code` is the peer's WebSocket close code where it
   * sent one (4401 means the device was revoked mid-stream), and `reason` is a
   * sentence for a person.
   */
  onClosed(outcome: { code: number | null; reason: string }): void
}

/**
 * Watch one machine's change feed (2026-09-05): a `changed` frame says its
 * workspace list or conversation list moved, and the caller re-reads. The
 * same ticket-then-upgrade the conversation socket uses, on the events route.
 */
export async function openRemoteEventsSocket(input: {
  endpoint: TailnetEndpoint
  token: string
  handlers: RemoteJsonSocketHandlers
}): Promise<RemoteCallOutcome<RemoteJsonSocket>> {
  const ticket = await requestSocketTicket(input.endpoint, input.token, 'a change feed')
  if (!ticket.ok) return ticket
  const upgraded = await upgradeSocket(input.endpoint, ticket.value, TAILNET_EVENTS_PATH)
  if (!upgraded.ok) return upgraded
  return { ok: true, value: driveJsonSocket(upgraded.value.socket, upgraded.value.leftover, input.handlers) }
}

/**
 * Follow conversations on a machine over its conversation socket: one
 * socket, one followed conversation at a time, as that route is scoped.
 * Frames arrive on `onFrame` as parsed JSON, unvalidated — the conversation
 * client validates them against the protocol, because only it knows which
 * frame a broken one would have been.
 *
 * The far end pings every 25 seconds. A socket that has heard nothing for
 * `livenessTimeoutMs` is a peer that vanished without a close (a laptop lid,
 * a dropped route), and is ended so the caller re-dials instead of waiting on
 * a link that will never speak again. This end only listens: the far end's
 * pings are what keep an idle link warm, and this end's pongs are what tell
 * the far end it is still here.
 */
export async function openRemoteConversationSocket(input: {
  endpoint: TailnetEndpoint
  token: string
  handlers: RemoteJsonSocketHandlers
  livenessTimeoutMs?: number
}): Promise<RemoteCallOutcome<RemoteJsonSocket>> {
  const ticket = await requestSocketTicket(input.endpoint, input.token, 'a conversation stream')
  if (!ticket.ok) return ticket
  const upgraded = await upgradeSocket(input.endpoint, ticket.value, TAILNET_CONVERSATION_PATH)
  if (!upgraded.ok) return upgraded
  return {
    ok: true,
    value: driveJsonSocket(upgraded.value.socket, upgraded.value.leftover, input.handlers, {
      livenessTimeoutMs: input.livenessTimeoutMs ?? CONVERSATION_LIVENESS_TIMEOUT_MS,
      unreadable: 'That machine sent a conversation frame this build could not read.',
    }),
  }
}

/**
 * A 30-second single-use ticket for one upgrade, never the device token: a
 * query string lands in logs and history, so the long-lived credential is only
 * ever an Authorization header.
 */
async function requestSocketTicket(
  endpoint: TailnetEndpoint,
  token: string,
  what: string,
): Promise<RemoteCallOutcome<string>> {
  let ticketAnswer: JsonAnswer
  try {
    ticketAnswer = await requestTailnetJson({ endpoint, method: 'POST', path: TAILNET_WS_TICKET_PATH, token, body: {} })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(endpoint, error) }
  }
  if (ticketAnswer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const ticket = asRecord(ticketAnswer.body)?.ticket
  if (ticketAnswer.status !== 200 || typeof ticket !== 'string') {
    return {
      ok: false,
      code: `http_${ticketAnswer.status}`,
      message: `That machine would not open ${what} (HTTP ${ticketAnswer.status}).`,
    }
  }
  return { ok: true, value: ticket }
}

/** Open the TCP socket and complete the RFC 6455 handshake against one of the listener's WebSocket routes. */
function upgradeSocket(
  endpoint: TailnetEndpoint,
  ticket: string,
  path: string,
): Promise<RemoteCallOutcome<{ socket: Socket; leftover: Buffer }>> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64')
    const expectedAccept = computeWebSocketAcceptKey(key)
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let head = Buffer.alloc(0)
    let settled = false

    const settle = (outcome: RemoteCallOutcome<{ socket: Socket; leftover: Buffer }>): void => {
      if (settled) return
      settled = true
      // Hand the socket over with no handshake listeners left on it, and with
      // the connect timeout cleared: a change feed is idle most of its life and
      // must never be timed out for it.
      socket.setTimeout(0)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (!outcome.ok) socket.destroy()
      resolve(outcome)
    }
    const refuse = (code: string, text: string): void => settle({ ok: false, code, message: text })
    const onError = (error: Error): void => refuse('unreachable', describeUnreachable(endpoint, error))
    const onClose = (): void => refuse('unreachable', 'That machine closed the connection during the handshake.')
    const onTimeout = (): void =>
      refuse('unreachable', describeUnreachable(endpoint, new Error('the handshake got no answer')))
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const boundary = head.indexOf('\r\n\r\n')
      if (boundary === -1) {
        if (head.length > 64 * 1024) refuse('protocol', 'That machine sent an oversized handshake response.')
        return
      }
      const header = head.subarray(0, boundary).toString('utf8')
      const leftover = head.subarray(boundary + 4)
      const [statusLine, ...headerLines] = header.split('\r\n')
      const status = Number(statusLine.split(' ')[1])
      const headers = new Map(
        headerLines.map((line): [string, string] => {
          const colon = line.indexOf(':')
          return colon === -1
            ? [line.toLowerCase(), '']
            : [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
        }),
      )
      if (status !== 101) {
        // The listener names its refusals in a header; carrying that code
        // through is what lets the pane say "watch-only" instead of "HTTP 403".
        const code = headers.get('x-tailnet-error') ?? `http_${status}`
        refuse(code, refusalMessage(code, status))
        return
      }
      if (headers.get('sec-websocket-accept') !== expectedAccept) {
        refuse('protocol', 'The handshake key did not verify; that endpoint is not a Studio tailnet listener.')
        return
      }
      // Kernel keepalive for the socket's life: a watch that carries nothing
      // while nothing changes has no other way to notice the far end is gone.
      enableTcpKeepAlive(socket)
      settle({ ok: true, value: { socket, leftover } })
    }

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
    socket.on('timeout', onTimeout)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.on('connect', () => {
      const search = new URLSearchParams({ ticket })
      socket.write(
        [
          `GET ${path}?${search.toString()} HTTP/1.1`,
          `Host: ${formatTailnetEndpoint(endpoint)}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

/** Frame loop for an upgraded JSON socket: the change feed, or a conversation. */
function driveJsonSocket(
  socket: Socket,
  leftover: Buffer,
  handlers: RemoteJsonSocketHandlers,
  options: { livenessTimeoutMs?: number; unreadable?: string } = {},
): RemoteJsonSocket {
  const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES, 'client')
  let closed = false
  let closeCode: number | null = null
  let closeReason = 'The connection to that machine ended.'
  let heardAt = Date.now()
  const liveness = options.livenessTimeoutMs
  // Listen-only liveness. The far end pings every 25 seconds, which keeps the
  // path warm for middleboxes and is what refreshes `heardAt`; a ping from
  // this end as well only made both machines wake for a pong neither needed.
  // One timer, re-armed for whatever is left of the window when it fires, so
  // a link that is talking costs a wakeup per window rather than per beat.
  let heartbeat: NodeJS.Timeout | null = null
  const armLiveness = (delayMs: number): void => {
    if (liveness === undefined || closed) return
    heartbeat = setTimeout(
      () => {
        heartbeat = null
        if (closed) return
        const silentMs = Date.now() - heardAt
        if (silentMs > liveness) {
          closeReason = 'That machine stopped answering.'
          finish()
          return
        }
        armLiveness(liveness - silentMs + 1)
      },
      Math.max(10, delayMs),
    )
    heartbeat.unref?.()
  }

  const finish = (): void => {
    if (closed) return
    closed = true
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = null
    socket.destroy()
    handlers.onClosed({ code: closeCode, reason: closeReason })
  }

  const consume = (chunk: Buffer): void => {
    if (closed) return
    heardAt = Date.now()
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      closeReason = decoded.reason
      finish()
      return
    }
    for (const frame of decoded.frames) {
      if (frame.kind === 'close') {
        closeCode = frame.code
        closeReason = frame.reason || closeReasonFor(frame.code)
        finish()
        return
      }
      if (frame.kind === 'ping') {
        if (!socket.destroyed) socket.write(encodeMaskedPongFrame(frame.payload))
        continue
      }
      if (frame.kind !== 'text') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        // A frame we cannot read is a protocol failure, not something to skip:
        // silently dropping it would leave a pane waiting for a frame forever.
        closeReason = options.unreadable ?? 'That machine sent a frame this build could not read.'
        finish()
        return
      }
      const record = asRecord(parsed)
      if (record) handlers.onFrame(record)
    }
  }

  socket.on('data', consume)
  // An upgraded socket is half-open: a peer that vanishes makes Node emit
  // `end`, not `close`. Handling only one leaves a dead socket believed live.
  socket.on('end', () => {
    closeReason = 'That machine stopped answering.'
    finish()
  })
  socket.on('close', finish)
  socket.on('error', (error: Error) => {
    closeReason = `The connection to that machine failed: ${message(error)}.`
    finish()
  })
  if (leftover.length > 0) consume(leftover)
  if (liveness !== undefined) armLiveness(liveness + 1)

  return {
    send(frame): void {
      if (closed || socket.destroyed) return
      socket.write(encodeMaskedTextFrame(JSON.stringify(frame)))
    },
    close(reason): void {
      if (closed) return
      closeReason = reason
      if (!socket.destroyed) {
        try {
          socket.write(encodeMaskedCloseFrame(WEBSOCKET_CLOSE_NORMAL, ''))
        } catch {
          // The peer is already gone; destroying below is the whole cleanup.
        }
      }
      finish()
    },
    isOpen: () => !closed && !socket.destroyed,
  }
}

const UNAUTHORIZED_MESSAGE =
  'That machine no longer accepts this pairing. It was revoked there, or its app data was reset. Pair again to reconnect.'

function refusalMessage(code: string, status: number): string {
  if (code === 'conversation_scope_required') {
    return 'This pairing may not read conversations on that machine. Pair again with conversation access.'
  }
  if (code === 'conversation_streaming_unavailable') return 'That machine is not serving conversations right now.'
  if (code === 'unauthorized') return UNAUTHORIZED_MESSAGE
  return `That machine refused the stream (HTTP ${status}, ${code}).`
}

function closeReasonFor(code: number): string {
  if (code === 4401) return 'That machine revoked this pairing, so the stream was disconnected.'
  if (code === 4403) return 'This pairing may no longer read conversations on that machine.'
  if (code === 4409) return 'That machine asked this device to reconnect and catch up.'
  if (code === 1000 || code === 1001) return 'That machine closed the stream.'
  return `The stream closed (code ${code}).`
}

function describeUnreachable(endpoint: TailnetEndpoint, error: unknown): string {
  return `${formatTailnetEndpoint(endpoint)} did not answer: ${message(error)}.`
}

function readScopes(value: unknown): TailnetScope[] {
  return Array.isArray(value) ? value.filter(isTailnetScope) : []
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
