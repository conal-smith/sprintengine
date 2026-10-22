// How large a picture says it is, read from its header without decoding it.
//
// A few kilobytes of PNG or JPEG can declare a picture of billions of pixels,
// and decoding one allocates all of them. So a picture that arrives from
// elsewhere (a paired device's upload, a client's, a project's logo) is
// measured first, and one over these limits is not decoded at all. The limits
// are far beyond any camera or screen: 16384 pixels a side, 100 megapixels.

export const IMAGE_MAX_SIDE = 16_384
export const IMAGE_MAX_PIXELS = 100_000_000

export type ImageDimensions = { width: number; height: number }
export type ImageHeaderKind = 'png' | 'jpeg' | 'gif' | 'webp'

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1]
const u16le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8)
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) >>> 0) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))

/** Which of the formats measured here the bytes start as, or null. */
export function imageHeaderKind(bytes: Uint8Array): ImageHeaderKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n\x1a\n')) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp'
  return null
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    // Fill bytes before a marker.
    while (at < bytes.length && bytes[at] === 0xff) at++
    const marker = bytes[at]
    at++
    // Markers that stand alone, with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    if (at + 1 >= bytes.length) return null
    const length = u16be(bytes, at)
    if (length < 2) return null
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (frame) {
      if (at + 6 >= bytes.length) return null
      return { height: u16be(bytes, at + 3), width: u16be(bytes, at + 5) }
    }
    at += length
  }
  return null
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (ascii(bytes, 12, 'VP8X') && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  if (ascii(bytes, 12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(bytes, 12, 'VP8 ') && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }
  return null
}

/** The size a PNG, JPEG, GIF or WebP declares, or null when the header cannot be read. */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | null {
  switch (imageHeaderKind(bytes)) {
    case 'png':
      return bytes.length >= 24 && ascii(bytes, 12, 'IHDR')
        ? { width: u32be(bytes, 16), height: u32be(bytes, 20) }
        : null
    case 'jpeg':
      return jpegDimensions(bytes)
    case 'gif':
      return bytes.length >= 10 ? { width: u16le(bytes, 6), height: u16le(bytes, 8) } : null
    case 'webp':
      return webpDimensions(bytes)
    default:
      return null
  }
}

/**
 * Whether bytes may be handed to an image decoder: false only when a PNG,
 * JPEG, GIF or WebP header declares a picture over the limits. Bytes whose
 * header cannot be read declare no size for a decoder to allocate, and are
 * left to it.
 */
export function imageWithinDecodeLimits(bytes: Uint8Array): boolean {
  const size = imageDimensions(bytes)
  if (!size) return true
  return size.width <= IMAGE_MAX_SIDE && size.height <= IMAGE_MAX_SIDE && size.width * size.height <= IMAGE_MAX_PIXELS
}
