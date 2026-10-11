// A macOS app icon built in memory, so a suite states the chunks it reads
// rather than shipping a binary fixture: the `icns` header, then each chunk as
// its 4-byte type, its length counting its own 8-byte header, and its payload.
export function icnsFile(...chunks: Array<[type: string, payload: Buffer]>): Buffer {
  const parts = chunks.map(([type, payload]) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'latin1')
    header.writeUInt32BE(8 + payload.byteLength, 4)
    return Buffer.concat([header, payload])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(8 + parts.reduce((total, part) => total + part.byteLength, 0), 4)
  return Buffer.concat([header, ...parts])
}

// The start of a PNG `width` pixels square: its signature and IHDR header,
// which is all the reader looks at, and a tag to tell sizes apart by.
export function pngOfWidth(width: number): Buffer {
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'latin1')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(width, 20)
  return Buffer.concat([png, Buffer.from(`png${width}`)])
}
