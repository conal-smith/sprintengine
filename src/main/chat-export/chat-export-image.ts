// A picture's size and kind, read from its first bytes: what a Word document
// needs to place it, which the attachment store does not keep. PNG, JPEG, GIF
// and BMP, the kinds Word draws; anything else is null and is named instead.

export type ExportImageKind = 'png' | 'jpg' | 'gif' | 'bmp'

export type ExportImageInfo = { kind: ExportImageKind; width: number; height: number }

export function readExportImageInfo(data: Uint8Array): ExportImageInfo | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const at = (offset: number) => (offset < data.byteLength ? data[offset]! : -1)
  const sized = (kind: ExportImageKind, width: number, height: number): ExportImageInfo | null =>
    width > 0 && height > 0 ? { kind, width, height } : null
  try {
    // PNG: the signature, then the IHDR chunk's width and height.
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && data.byteLength >= 24)
      return sized('png', view.getUint32(16), view.getUint32(20))
    // GIF: the logical screen's size, little-endian.
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && data.byteLength >= 10)
      return sized('gif', view.getUint16(6, true), view.getUint16(8, true))
    // BMP: the info header's size; a bottom-up bitmap has a negative height.
    if (at(0) === 0x42 && at(1) === 0x4d && data.byteLength >= 26)
      return sized('bmp', Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)))
    // JPEG: walk the segments to the first frame header.
    if (at(0) === 0xff && at(1) === 0xd8) {
      let offset = 2
      while (offset + 9 < data.byteLength) {
        if (at(offset) !== 0xff) return null
        const marker = at(offset + 1)
        // Fill bytes before a marker.
        if (marker === 0xff) {
          offset += 1
          continue
        }
        const length = view.getUint16(offset + 2)
        const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (frame) return sized('jpg', view.getUint16(offset + 7), view.getUint16(offset + 5))
        offset += 2 + length
      }
    }
  } catch {
    // A truncated header is not a picture this can place.
  }
  return null
}

/** `width` x `height` shrunk, never grown, to fit inside the box. */
export function fitImage(
  size: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number } {
  const scale = Math.min(1, box.width / size.width, box.height / size.height)
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}
