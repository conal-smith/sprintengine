import { isUtf8 } from 'buffer'
import { createHash, randomBytes } from 'crypto'

// A minimal RFC 6455 codec: handshake accept key, frame decode, frame encode.
// Hand-written for the same reason mcp-socket-server.ts hand-writes its
// JSON-RPC — the app ships no WebSocket dependency, and the slice this listener
// needs (text frames, ping/pong, close) is small and fully specified.
//
// Both roles live here. The listener is the server half; the Mesh client
// dials OTHER machines from this same process, and giving it its own
// copy of the framing would be two implementations of one wire format, drifting
// against each other in a security-relevant file. The role only changes who
// masks (RFC 6455 §5.1: clients must, servers must not).
//
// What is deliberately NOT implemented, because no client of this transport
// uses it and a half-implementation would be worse than an explicit refusal:
// - extensions (`permessage-deflate` and friends) are never negotiated;
// - binary frames are refused (the payload here is JSON-RPC text).
// Each refusal closes the connection with a close code that says why.
//
// A text message in fragments (RFC 6455 §5.4) is gathered and read whole:
// the spec lets any client or intermediary split a message, and a server
// that closed on one would drop a peer that did nothing wrong. The size cap
// is the message's, not each fragment's, and control frames may arrive
// between fragments. Text is checked to be UTF-8 once whole (a fragment may
// end mid-character), and a message that is not closes with 1007.

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Close codes this server sends (RFC 6455 §7.4.1 plus the 4xxx private range). */
export const WEBSOCKET_CLOSE_NORMAL = 1000
export const WEBSOCKET_CLOSE_GOING_AWAY = 1001
const WEBSOCKET_CLOSE_PROTOCOL_ERROR = 1002
const WEBSOCKET_CLOSE_UNSUPPORTED_DATA = 1003
const WEBSOCKET_CLOSE_INVALID_PAYLOAD = 1007
const WEBSOCKET_CLOSE_MESSAGE_TOO_BIG = 1009
/** Private-range code for a device whose access was revoked mid-stream. */
export const WEBSOCKET_CLOSE_REVOKED = 4401

/** One message may not exceed this; matches the socket transport's 1 MiB line cap. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024

/**
 * How long a WebSocket's TCP connection may sit silent before the kernel
 * starts probing it. Both roles turn it on for every upgraded socket.
 */
export const WEBSOCKET_TCP_KEEPALIVE_MS = 30_000

/**
 * Turn on TCP keepalive for an upgraded socket, whichever role holds it.
 *
 * The probes are the kernel's, so they cost the process no timer and no
 * wakeup, and they find a peer that disappeared without a close: a laptop that
 * slept, a Wi-Fi handover, a re-keyed tunnel. A socket that carries nothing
 * while nothing happens (the change feed) has no other way to learn it is
 * talking to nobody. Typed loosely because an `upgrade` hands the server a
 * `Duplex`; every socket here is a `net.Socket` in fact, and one that is not
 * simply goes without.
 */
export function enableTcpKeepAlive(socket: unknown): void {
  const candidate = socket as { setKeepAlive?: (enable: boolean, initialDelay: number) => unknown } | null
  try {
    candidate?.setKeepAlive?.(true, WEBSOCKET_TCP_KEEPALIVE_MS)
  } catch {
    // A socket already torn down: nothing left to keep alive.
  }
}

export function computeWebSocketAcceptKey(clientKey: string): string {
  return createHash('sha1').update(`${clientKey}${WEBSOCKET_GUID}`).digest('base64')
}

type WebSocketFrame =
  | { kind: 'text'; text: string }
  | { kind: 'ping'; payload: Buffer }
  | { kind: 'pong' }
  /** Code/reason are carried for a client that must report WHY the peer hung up (4401 revoked, say). */
  | { kind: 'close'; code: number; reason: string }
  /**
   * A text message over the size cap that the decoder was asked to skip
   * rather than close on. Its payload is discarded as it arrives; only its
   * first bytes are kept, so the reply can name what the message was.
   */
  | { kind: 'oversized'; bytes: number; prefix: string }

type WebSocketDecodeResult =
  { kind: 'frames'; frames: WebSocketFrame[] } | { kind: 'error'; code: number; reason: string }

export type WebSocketFrameDecoder = {
  /** Feed received bytes; returns whole frames, or the failure that must close the socket. */
  push(chunk: Buffer): WebSocketDecodeResult
}

/**
 * Which side of the connection is decoding.
 *
 * `server` requires every incoming frame to be masked, because the spec
 * requires a client to mask and an unmasked client frame is a violation the
 * server must fail on. `client` decodes frames from the listener, which are
 * never masked — but honours the mask bit anyway, because reading the bit is
 * what decoding a frame means, not an optimism about who sent it.
 */
export type WebSocketDecoderRole = 'server' | 'client'

const OVERSIZED_PREFIX_BYTES = 1024

export function createWebSocketFrameDecoder(
  maxMessageBytes: number = MAX_WEBSOCKET_MESSAGE_BYTES,
  role: WebSocketDecoderRole = 'server',
  /**
   * Text messages over `maxMessageBytes` but no larger than this are skipped
   * and reported as `oversized` instead of failing the connection, for a
   * transport that answers them with a typed refusal. Beyond it, or with no
   * value, an oversized message still closes the socket. A fragmented message
   * is measured by all its fragments, and reported once its last one ends.
   */
  skipOversizedTextUpTo = 0,
): WebSocketFrameDecoder {
  let buffer: Buffer = Buffer.alloc(0)
  // Payload bytes of a skipped message still to arrive and be discarded.
  let skipping = 0
  const hardLimit = Math.max(maxMessageBytes, skipOversizedTextUpTo)
  // A frame still arriving is gathered in its chunks and joined once it is
  // whole: joined on every chunk, a message of megabytes in network-sized
  // pieces is copied hundreds of times over, holding the event loop.
  let waiting: Buffer[] = []
  let waitingBytes = 0
  let needed = 0
  // A fragmented text message still arriving: its fragments' payloads, or,
  // once it is over the cap and being skipped, only its first bytes.
  let message: { bytes: number; parts: Buffer[]; skipped: boolean; prefix: Buffer } | null = null
  const fail = (code: number, reason: string): WebSocketDecodeResult => ({ kind: 'error', code, reason })

  return {
    push(chunk: Buffer): WebSocketDecodeResult {
      if (needed > 0 && buffer.length + waitingBytes + chunk.length < needed) {
        waiting.push(chunk)
        waitingBytes += chunk.length
        return { kind: 'frames', frames: [] }
      }
      buffer = buffer.length === 0 && waiting.length === 0 ? chunk : Buffer.concat([buffer, ...waiting, chunk])
      waiting = []
      waitingBytes = 0
      needed = 0
      const frames: WebSocketFrame[] = []
      for (;;) {
        if (skipping > 0) {
          const dropped = Math.min(skipping, buffer.length)
          buffer = buffer.subarray(dropped)
          skipping -= dropped
          if (skipping > 0) return { kind: 'frames', frames }
        }
        if (buffer.length < 2) return { kind: 'frames', frames }
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const reserved = first & 0x70
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2

        if (reserved !== 0) {
          // Reserved bits are only meaningful for an extension, and this server
          // negotiates none — so a peer setting them is speaking a dialect we
          // did not agree to, not something to interpret optimistically.
          return {
            kind: 'error',
            code: WEBSOCKET_CLOSE_PROTOCOL_ERROR,
            reason: 'Reserved frame bits are set but no extension was negotiated.',
          }
        }
        if (!masked && role === 'server') {
          // RFC 6455 §5.1: a client MUST mask. An unmasked client frame is a
          // protocol violation the spec requires the server to fail on.
          return { kind: 'error', code: WEBSOCKET_CLOSE_PROTOCOL_ERROR, reason: 'Client frames must be masked.' }
        }
        if (length === 126) {
          if (buffer.length < offset + 2) return { kind: 'frames', frames }
          length = buffer.readUInt16BE(offset)
          offset += 2
        } else if (length === 127) {
          if (buffer.length < offset + 8) return { kind: 'frames', frames }
          const extended = buffer.readBigUInt64BE(offset)
          if (extended > BigInt(hardLimit)) {
            return {
              kind: 'error',
              code: WEBSOCKET_CLOSE_MESSAGE_TOO_BIG,
              reason: `Frame exceeds the ${maxMessageBytes}-byte limit.`,
            }
          }
          length = Number(extended)
          offset += 8
        }
        const control = opcode >= 0x8
        if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) {
          return fail(
            WEBSOCKET_CLOSE_UNSUPPORTED_DATA,
            `Opcode 0x${opcode.toString(16)} is not supported; this transport carries JSON-RPC text frames.`,
          )
        }
        if (control && !fin) return fail(WEBSOCKET_CLOSE_PROTOCOL_ERROR, 'Control frames must not be fragmented.')
        if (opcode === 0x0 && !message)
          return fail(WEBSOCKET_CLOSE_PROTOCOL_ERROR, 'A continuation frame arrived with no message to continue.')
        if (opcode === 0x1 && message)
          return fail(WEBSOCKET_CLOSE_PROTOCOL_ERROR, 'A new message began before the fragmented one ended.')
        const maskLength = masked ? 4 : 0

        if (opcode === 0x0 || (opcode === 0x1 && !fin)) {
          // One fragment of a text message (RFC 6455 §5.4).
          const total = (message?.bytes ?? 0) + length
          if (total > hardLimit) {
            return fail(WEBSOCKET_CLOSE_MESSAGE_TOO_BIG, `Message exceeds the ${maxMessageBytes}-byte limit.`)
          }
          const gathering = message ?? { bytes: 0, parts: [], skipped: false, prefix: Buffer.alloc(0) }
          if (total > maxMessageBytes) {
            // Over the cap, within what may be skipped: keep the first bytes
            // for the refusal, and discard the rest as it streams in.
            if (!gathering.skipped) {
              gathering.prefix = Buffer.concat(gathering.parts).subarray(0, OVERSIZED_PREFIX_BYTES)
              gathering.parts = []
              gathering.skipped = true
            }
            const kept = Math.min(length, OVERSIZED_PREFIX_BYTES - gathering.prefix.length)
            if (buffer.length < offset + maskLength + kept) return { kind: 'frames', frames }
            if (kept > 0) {
              const mask = masked ? buffer.subarray(offset, offset + 4) : null
              const more = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + kept))
              if (mask) for (let index = 0; index < more.length; index += 1) more[index] ^= mask[index % 4]
              gathering.prefix = Buffer.concat([gathering.prefix, more])
            }
            gathering.bytes = total
            buffer = buffer.subarray(offset + maskLength)
            skipping = length
            if (fin) {
              frames.push({ kind: 'oversized', bytes: total, prefix: gathering.prefix.toString('utf8') })
              message = null
            } else message = gathering
            continue
          }
          if (buffer.length < offset + maskLength + length) {
            needed = offset + maskLength + length
            return { kind: 'frames', frames }
          }
          const mask = masked ? buffer.subarray(offset, offset + 4) : null
          const part = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
          if (mask) for (let index = 0; index < part.length; index += 1) part[index] ^= mask[index % 4]
          buffer = buffer.subarray(offset + maskLength + length)
          gathering.parts.push(part)
          gathering.bytes = total
          if (!fin) {
            message = gathering
            continue
          }
          message = null
          const whole = Buffer.concat(gathering.parts)
          if (!isUtf8(whole)) return fail(WEBSOCKET_CLOSE_INVALID_PAYLOAD, 'Text messages must be valid UTF-8.')
          frames.push({ kind: 'text', text: whole.toString('utf8') })
          continue
        }

        if (length > maxMessageBytes && !(opcode === 0x1 && fin && length <= skipOversizedTextUpTo)) {
          return {
            kind: 'error',
            code: WEBSOCKET_CLOSE_MESSAGE_TOO_BIG,
            reason: `Frame exceeds the ${maxMessageBytes}-byte limit.`,
          }
        }
        if (opcode >= 0x8 && length > 125) {
          return {
            kind: 'error',
            code: WEBSOCKET_CLOSE_PROTOCOL_ERROR,
            reason: 'Control frame exceeds the 125-byte limit.',
          }
        }
        if (length > maxMessageBytes) {
          // Keep the first bytes, discard the rest as it streams in: a message
          // this size is never buffered whole.
          const kept = Math.min(length, OVERSIZED_PREFIX_BYTES)
          if (buffer.length < offset + maskLength + kept) return { kind: 'frames', frames }
          const mask = masked ? buffer.subarray(offset, offset + 4) : null
          const prefix = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + kept))
          if (mask) for (let index = 0; index < prefix.length; index += 1) prefix[index] ^= mask[index % 4]
          frames.push({ kind: 'oversized', bytes: length, prefix: prefix.toString('utf8') })
          buffer = buffer.subarray(offset + maskLength)
          skipping = length
          continue
        }
        if (buffer.length < offset + maskLength + length) {
          needed = offset + maskLength + length
          return { kind: 'frames', frames }
        }

        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        offset += maskLength
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        buffer = buffer.subarray(offset + length)

        switch (opcode) {
          case 0x1:
            if (!isUtf8(payload)) return fail(WEBSOCKET_CLOSE_INVALID_PAYLOAD, 'Text messages must be valid UTF-8.')
            frames.push({ kind: 'text', text: payload.toString('utf8') })
            break
          case 0x8:
            frames.push({
              kind: 'close',
              // 1005 is "no status present", the code RFC 6455 reserves for
              // exactly this: a close body too short to carry one.
              code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
              reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '',
            })
            return { kind: 'frames', frames }
          case 0x9:
            frames.push({ kind: 'ping', payload })
            break
          case 0xa:
            frames.push({ kind: 'pong' })
            break
          // Every other opcode was refused above, from its header.
        }
      }
    },
  }
}

export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'))
}

export function encodePongFrame(payload: Buffer): Buffer {
  return encodeFrame(0xa, payload)
}

export function encodePingFrame(payload: Buffer = Buffer.alloc(0)): Buffer {
  return encodeFrame(0x9, payload.subarray(0, 125))
}

export function encodeCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  // The close body is a 2-byte code plus an optional reason, capped at 125
  // bytes total because close is a control frame.
  const payload = Buffer.concat([Buffer.alloc(2), reasonBytes.subarray(0, 123)])
  payload.writeUInt16BE(code, 0)
  return encodeFrame(0x8, payload)
}

/** A text frame from the CLIENT half, masked as the spec requires. */
export function encodeMaskedTextFrame(text: string): Buffer {
  return encodeMaskedFrame(0x1, Buffer.from(text, 'utf8'))
}

export function encodeMaskedCloseFrame(code: number, reason = ''): Buffer {
  const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason, 'utf8').subarray(0, 123)])
  payload.writeUInt16BE(code, 0)
  return encodeMaskedFrame(0x8, payload)
}

export function encodeMaskedPongFrame(payload: Buffer): Buffer {
  return encodeMaskedFrame(0xa, payload)
}

/**
 * Client frames MUST be masked with a fresh random key per frame (RFC 6455
 * §5.3). The mask is not a secret and buys nothing against a reader — it exists
 * so intermediaries cannot be tricked into parsing frame bytes as a request —
 * but the listener refuses unmasked client frames, so this is also simply what
 * it takes to be understood.
 */
function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : payload.length < 65536
        ? (() => {
            const bytes = Buffer.alloc(4)
            bytes[0] = 0x80 | opcode
            bytes[1] = 0x80 | 126
            bytes.writeUInt16BE(payload.length, 2)
            return bytes
          })()
        : (() => {
            const bytes = Buffer.alloc(10)
            bytes[0] = 0x80 | opcode
            bytes[1] = 0x80 | 127
            bytes.writeBigUInt64BE(BigInt(payload.length), 2)
            return bytes
          })()
  return Buffer.concat([header, mask, masked])
}

/** Server frames are never masked (RFC 6455 §5.1). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? (() => {
            const bytes = Buffer.alloc(4)
            bytes[0] = 0x80 | opcode
            bytes[1] = 126
            bytes.writeUInt16BE(payload.length, 2)
            return bytes
          })()
        : (() => {
            const bytes = Buffer.alloc(10)
            bytes[0] = 0x80 | opcode
            bytes[1] = 127
            bytes.writeBigUInt64BE(BigInt(payload.length), 2)
            return bytes
          })()
  return Buffer.concat([header, payload])
}
