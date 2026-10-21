// A PNG encoder and decoder on Node built-ins alone, for the brand generator
// (scripts/generate-brand-icons.mjs).
//
// Ported from the desktop's own brand tooling so the phone's icons are cut the
// same way the Mac icon is. The icons are generated rather than exported from an
// editor so that every committed binary has a source that reproduces it, and an
// image-library dependency would make that source harder to run than the asset
// is to look at. So: zlib for the compression, and the rest is the format.

import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.allocUnsafe(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([lenBuf, t, data, crcBuf])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Encode 8-bit pixels, unfiltered. `channels` is 3 (RGB, for an icon that must
 * carry no alpha channel at all, which is what the App Store asks of the iOS
 * icon) or 4 (RGBA).
 */
export function encodePNG(width, height, pixels, { channels = 4, level = 9 } = {}) {
  const stride = width * channels
  const rows = []
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), pixels.subarray(y * stride, (y + 1) * stride))
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level })

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG. */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} is not supported`)
  if (colorType !== 2 && colorType !== 6) throw new Error(`colour type ${colorType} is not supported`)

  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      const v = line[i]
      let predicted = v
      if (filter === 1) predicted = v + a
      else if (filter === 2) predicted = v + b
      else if (filter === 3) predicted = v + ((a + b) >> 1)
      else if (filter === 4) predicted = v + paeth(a, b, c)
      cur[i] = predicted & 0xff
    }
  }
  return { width, height, bpp, pixels: out }
}
