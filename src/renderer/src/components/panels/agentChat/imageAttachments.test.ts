import { afterEach, expect, test, vi } from 'vitest'

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_EDGE, readImageAttachment } from './imageAttachments'

// The renderer's image pipeline, with the browser parts stood in: an image that
// decodes at a given size, a canvas whose encoder returns blobs of given sizes,
// and a FileReader that base64-encodes what it is handed.
type Encoded = { type: string; quality?: number; size: number }

function stage(options: { width: number; height: number; encodes: Record<string, number> }) {
  const encoded: Encoded[] = []
  const read: Blob[] = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob: (callback: (blob: Blob | null) => void, type: string, quality?: number) => {
      const size = options.encodes[type] ?? 0
      encoded.push({ type, quality, size })
      setTimeout(() => callback(new Blob([new Uint8Array(size)], { type })))
    },
    toDataURL: () => {
      throw new Error('a synchronous encode blocks the renderer')
    },
  }
  class StubImage {
    naturalWidth = options.width
    naturalHeight = options.height
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      setTimeout(() => this.onload?.())
    }
  }
  class StubFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob) {
      read.push(blob)
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
        this.onload?.()
      })
    }
  }
  const revoked: string[] = []
  vi.stubGlobal('document', { createElement: () => canvas })
  vi.stubGlobal('Image', StubImage)
  vi.stubGlobal('FileReader', StubFileReader)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => revoked.push(url))
  return { canvas, encoded, read, revoked }
}

function file(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('an image that already fits is sent byte for byte, without a canvas', async () => {
  const { encoded, read, revoked } = stage({ width: 400, height: 300, encodes: {} })
  const gif = file('spinner.gif', 'image/gif', 2048)
  const attachment = await readImageAttachment(gif, 'att-1')
  expect(encoded).toEqual([])
  expect(read).toEqual([gif])
  expect(attachment).toMatchObject({ id: 'att-1', mediaType: 'image/gif', name: 'spinner.gif', byteLength: 2048 })
  expect(revoked).toEqual(['blob:image'])
})

test('an image too large to send is resampled through an asynchronous encode', async () => {
  const { canvas, encoded, read } = stage({ width: 3136, height: 1568, encodes: { 'image/png': 900_000 } })
  const attachment = await readImageAttachment(file('shot.png', 'image/png', 3_000_000), 'att-2')
  expect(canvas.width).toBe(MAX_ATTACHMENT_EDGE)
  expect(canvas.height).toBe(MAX_ATTACHMENT_EDGE / 2)
  expect(encoded.map((entry) => entry.type)).toEqual(['image/png'])
  expect(attachment).toMatchObject({ mediaType: 'image/png', name: 'shot.png', byteLength: 900_000 })
  // Only the encoding that is sent is read into base64 — never the original.
  expect(read.map((blob) => blob.size)).toEqual([900_000])
})

test('a PNG still over the limit after resampling falls back to JPEG', async () => {
  const { encoded } = stage({
    width: 4000,
    height: 3000,
    encodes: { 'image/png': MAX_ATTACHMENT_BYTES + 1, 'image/jpeg': 600_000 },
  })
  const attachment = await readImageAttachment(file('photo.png', 'image/png', 9_000_000), 'att-3')
  expect(encoded.map((entry) => [entry.type, entry.quality])).toEqual([
    ['image/png', undefined],
    ['image/jpeg', 0.82],
  ])
  expect(attachment).toMatchObject({ mediaType: 'image/jpeg', byteLength: 600_000 })
})

test('a JPEG is resampled as a JPEG, with no second encode', async () => {
  const { encoded } = stage({ width: 4000, height: 3000, encodes: { 'image/jpeg': 700_000 } })
  const attachment = await readImageAttachment(file('photo.jpg', 'image/jpeg', 6_000_000), 'att-4')
  expect(encoded.map((entry) => entry.type)).toEqual(['image/jpeg'])
  expect(attachment.mediaType).toBe('image/jpeg')
})

test('an image still over the limit after both encodes is refused, not cut short', async () => {
  const { read, revoked } = stage({
    width: 4000,
    height: 3000,
    encodes: { 'image/png': MAX_ATTACHMENT_BYTES + 1, 'image/jpeg': MAX_ATTACHMENT_BYTES + 1 },
  })
  await expect(readImageAttachment(file('huge.png', 'image/png', 20_000_000), 'att-5')).rejects.toThrow(
    'huge.png is still over 5.0 MB after resizing.',
  )
  expect(read).toEqual([])
  expect(revoked).toEqual(['blob:image'])
})
