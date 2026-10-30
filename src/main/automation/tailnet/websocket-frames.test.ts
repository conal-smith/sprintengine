import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createWebSocketFrameDecoder, type WebSocketFrameDecoder } from './websocket-frames'

// Fragmented messages (RFC 6455 §5.4) and the UTF-8 rule for text. The rest
// of the codec is covered with the listener, in tailnet.test.ts.

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d])

/** One frame as a client sends it: masked, with the opcode and FIN bit given. */
function frame(opcode: number, payload: Buffer | string, fin: boolean, masked = true): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const head: number[] = [(fin ? 0x80 : 0) | opcode]
  const maskBit = masked ? 0x80 : 0
  if (body.length < 126) head.push(maskBit | body.length)
  else {
    head.push(maskBit | 126, body.length >> 8, body.length & 0xff)
  }
  if (!masked) return Buffer.concat([Buffer.from(head), body])
  const out = Buffer.from(body)
  for (let index = 0; index < out.length; index += 1) out[index] ^= MASK[index % 4]
  return Buffer.concat([Buffer.from(head), MASK, out])
}

const TEXT = 0x1
const CONTINUATION = 0x0
const PING = 0x9

function texts(decoder: WebSocketFrameDecoder, bytes: Buffer): Array<{ kind: string; text?: string }> {
  const result = decoder.push(bytes)
  assert.equal(result.kind, 'frames', result.kind === 'error' ? result.reason : '')
  return result.kind === 'frames'
    ? result.frames.map((got) => (got.kind === 'text' ? { kind: 'text', text: got.text } : { kind: got.kind }))
    : []
}

function errorOf(decoder: WebSocketFrameDecoder, bytes: Buffer): { code: number; reason: string } {
  const result = decoder.push(bytes)
  assert.equal(result.kind, 'error')
  return result.kind === 'error' ? { code: result.code, reason: result.reason } : { code: 0, reason: '' }
}

test('a text message in fragments reads whole, with a ping between them', () => {
  const decoder = createWebSocketFrameDecoder()
  const got = texts(
    decoder,
    Buffer.concat([
      frame(TEXT, '{"hello":', false),
      frame(PING, '', true),
      frame(CONTINUATION, '"wor', false),
      frame(CONTINUATION, 'ld"}', true),
      frame(TEXT, '{"next":1}', true),
    ]),
  )
  assert.deepEqual(got, [
    { kind: 'ping' },
    { kind: 'text', text: '{"hello":"world"}' },
    { kind: 'text', text: '{"next":1}' },
  ])
})

test('a fragment may end mid-character, and the fragments may arrive a byte at a time', () => {
  const word = Buffer.from('"café"', 'utf8')
  const split = word.indexOf(0xc3) + 1
  const bytes = Buffer.concat([
    frame(TEXT, word.subarray(0, split), false),
    frame(CONTINUATION, word.subarray(split), true),
  ])
  const decoder = createWebSocketFrameDecoder()
  const got: Array<{ kind: string; text?: string }> = []
  for (let index = 0; index < bytes.length; index += 1) got.push(...texts(decoder, bytes.subarray(index, index + 1)))
  assert.deepEqual(got, [{ kind: 'text', text: '"café"' }])
})

test('the size cap is the whole message’s, not each fragment’s', () => {
  const decoder = createWebSocketFrameDecoder(16)
  assert.deepEqual(texts(decoder, frame(TEXT, '0123456789', false)), [])
  const refused = errorOf(decoder, frame(CONTINUATION, '0123456789', true))
  assert.equal(refused.code, 1009)
  assert.match(refused.reason, /16-byte limit/u)
})

test('a fragmented message over the cap but within the skip ceiling is reported once, and the next one reads', () => {
  const decoder = createWebSocketFrameDecoder(16, 'server', 64)
  const got = texts(
    decoder,
    Buffer.concat([
      frame(TEXT, '{"big":"', false),
      frame(CONTINUATION, 'x'.repeat(20), false),
      frame(CONTINUATION, 'y'.repeat(20), true),
      frame(TEXT, '{"next":1}', true),
    ]),
  )
  assert.deepEqual(got, [{ kind: 'oversized' }, { kind: 'text', text: '{"next":1}' }])
  const result = createWebSocketFrameDecoder(16, 'server', 64).push(
    Buffer.concat([frame(TEXT, '{"big":"', false), frame(CONTINUATION, 'x'.repeat(20), true)]),
  )
  assert.equal(result.kind, 'frames')
  const oversized = result.kind === 'frames' ? result.frames[0] : null
  assert.deepEqual(oversized, { kind: 'oversized', bytes: 28, prefix: `{"big":"${'x'.repeat(20)}` })

  const beyond = createWebSocketFrameDecoder(16, 'server', 64)
  assert.deepEqual(texts(beyond, frame(TEXT, 'a'.repeat(40), false)), [])
  assert.equal(errorOf(beyond, frame(CONTINUATION, 'b'.repeat(40), true)).code, 1009)
})

test('fragments out of order, and a fragmented control frame, are protocol errors', () => {
  const orphan = errorOf(createWebSocketFrameDecoder(), frame(CONTINUATION, 'x', true))
  assert.equal(orphan.code, 1002)
  assert.match(orphan.reason, /no message to continue/u)

  const interleaved = createWebSocketFrameDecoder()
  assert.deepEqual(texts(interleaved, frame(TEXT, 'a', false)), [])
  const restarted = errorOf(interleaved, frame(TEXT, 'b', true))
  assert.equal(restarted.code, 1002)
  assert.match(restarted.reason, /before the fragmented one ended/u)

  const control = errorOf(createWebSocketFrameDecoder(), frame(PING, '', false))
  assert.equal(control.code, 1002)
  assert.match(control.reason, /Control frames must not be fragmented/u)
})

test('text that is not UTF-8 closes with 1007, whole or in fragments', () => {
  const invalid = Buffer.from([0x22, 0xc3, 0x28, 0x22])
  assert.equal(errorOf(createWebSocketFrameDecoder(), frame(TEXT, invalid, true)).code, 1007)

  const fragmented = createWebSocketFrameDecoder()
  assert.deepEqual(texts(fragmented, frame(TEXT, Buffer.from([0x22, 0xc3]), false)), [])
  const refused = errorOf(fragmented, frame(CONTINUATION, Buffer.from([0x28, 0x22]), true))
  assert.equal(refused.code, 1007)
  assert.match(refused.reason, /valid UTF-8/u)
})

test('the client role reads a fragmented message from a server, unmasked', () => {
  const decoder = createWebSocketFrameDecoder(undefined, 'client')
  const got = texts(
    decoder,
    Buffer.concat([frame(TEXT, '{"a":', false, false), frame(CONTINUATION, '1}', true, false)]),
  )
  assert.deepEqual(got, [{ kind: 'text', text: '{"a":1}' }])
})
