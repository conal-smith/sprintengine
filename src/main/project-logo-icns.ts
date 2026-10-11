// A macOS app icon (`.icns`) is a container nothing in the app decodes, but
// one written by `iconutil` or Xcode carries its sizes as plain PNGs inside
// it. This reads the container's chunk list and hands back one of those PNGs,
// so an app's own icon can stand for its project.
//
// The layout is a 4-byte `icns` magic and a 4-byte big-endian total length,
// then chunks of the same shape: a 4-byte type (`ic07`, `ic10`, `icp5`, …), a
// 4-byte length that counts its own 8-byte header, and the payload. The type
// names a size, but the payload may be PNG, JPEG 2000, or a legacy packed
// bitmap depending on who wrote the file, so a chunk is judged by its own PNG
// signature and header rather than by its type.

const HEADER_BYTES = 8
const ICNS_MAGIC = 'icns'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// The PNG signature, then the IHDR chunk's length and type, then its width.
const PNG_WIDTH_OFFSET = 16
const PNG_MIN_BYTES = 24

// The width an embedded PNG declares, or null when the payload is not a PNG
// (JPEG 2000, a packed bitmap, a mask) or too short to carry its header.
function pngWidth(payload: Buffer): number | null {
  if (payload.byteLength < PNG_MIN_BYTES) return null
  if (!payload.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) return null
  if (payload.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = payload.readUInt32BE(PNG_WIDTH_OFFSET)
  return width > 0 ? width : null
}

/**
 * The smallest PNG in an `.icns` at least `minSize` wide, else the largest
 * there is; null when the file holds none or is not an `.icns`. The smallest
 * that covers the slot is what downscales best and costs least to decode — an
 * icon's 1024px master is the wrong thing to shrink to a sidebar glyph when
 * its 32px size was drawn for exactly that.
 *
 * A truncated or garbled file yields whatever PNGs precede the damage: a chunk
 * whose length is shorter than its own header, or runs past the end of the
 * bytes actually read, ends the walk. Returns a copy, so the caller does not
 * keep the whole file alive through it.
 */
export function extractIcnsPng(bytes: Buffer, minSize: number): Buffer | null {
  if (bytes.byteLength < HEADER_BYTES || bytes.toString('latin1', 0, 4) !== ICNS_MAGIC) return null
  const end = Math.min(bytes.readUInt32BE(4), bytes.byteLength)
  let best: { png: Buffer; width: number } | null = null
  for (let offset = HEADER_BYTES; offset + HEADER_BYTES <= end;) {
    const length = bytes.readUInt32BE(offset + 4)
    if (length < HEADER_BYTES || offset + length > end) break
    const payload = bytes.subarray(offset + HEADER_BYTES, offset + length)
    offset += length
    const width = pngWidth(payload)
    if (width === null) continue
    const better = best === null || (best.width < minSize ? width > best.width : width >= minSize && width < best.width)
    if (better) best = { png: payload, width }
  }
  return best ? Buffer.from(best.png) : null
}
