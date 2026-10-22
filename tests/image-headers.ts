// Picture headers, and nothing after them: what a decoder reads first, and
// all a check of a picture's declared size reads.

export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

export function jpegHeader(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip over, then a baseline frame header.
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x06,
    0x4a,
    0x46,
    0x49,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
  ])
}

export function gifHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8])
}

export function webpVp8xHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  )
  bytes.set(
    [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
    8,
  )
  const w = width - 1
  const h = height - 1
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24)
  return bytes
}
