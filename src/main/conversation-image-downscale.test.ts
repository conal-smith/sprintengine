import { expect, test } from 'vitest'

import { MAX_ATTACHMENT_BYTES } from '../shared/conversation-attachments'
import { downscaleConversationImage, type DecodedImage, type ImageCodec } from './conversation-image-downscale'

// A paired device's picture, sized for the model by the composer's rules.

type Drawn = { width: number; height: number; encodedAs?: string; quality?: number }

// A codec that decodes any bytes at `size` and encodes to `pngBytes` or
// `jpegBytes` bytes, recording what it drew and how it encoded it.
function standIn(options: { size: { width: number; height: number } | null; pngBytes?: number; jpegBytes?: number }) {
  const drawn: Drawn[] = []
  const image = (width: number, height: number): DecodedImage => ({
    width,
    height,
    resize: (nextWidth, nextHeight) => {
      drawn.push({ width: nextWidth, height: nextHeight })
      return image(nextWidth, nextHeight)
    },
    png: () => {
      drawn.push({ width, height, encodedAs: 'png' })
      return new Uint8Array(options.pngBytes ?? 1000)
    },
    jpeg: (quality) => {
      drawn.push({ width, height, encodedAs: 'jpeg', quality })
      return new Uint8Array(options.jpegBytes ?? 500)
    },
  })
  const codec: ImageCodec = { decode: () => (options.size ? image(options.size.width, options.size.height) : null) }
  return { codec, drawn }
}

const bytes = (length: number) => new Uint8Array(length)

test("a phone's photo is drawn at a 1568px long edge and stays a JPEG", () => {
  const { codec, drawn } = standIn({ size: { width: 4032, height: 3024 } })
  const result = downscaleConversationImage(codec, bytes(3_000_000), 'image/jpeg')
  expect(result.mediaType).toBe('image/jpeg')
  expect(result.bytes.byteLength).toBe(500)
  expect(drawn).toEqual([
    { width: 1568, height: 1176 },
    { width: 1568, height: 1176, encodedAs: 'jpeg', quality: 0.92 },
  ])
})

test('a screenshot is drawn smaller and stays a PNG while it fits', () => {
  const { codec, drawn } = standIn({ size: { width: 1290, height: 2796 } })
  const result = downscaleConversationImage(codec, bytes(4_000_000), 'image/png')
  expect(result.mediaType).toBe('image/png')
  expect(drawn.at(-1)).toEqual({ width: 723, height: 1568, encodedAs: 'png' })
})

test('a PNG still over the ceiling once drawn smaller goes as a JPEG', () => {
  const { codec, drawn } = standIn({
    size: { width: 6000, height: 4000 },
    pngBytes: MAX_ATTACHMENT_BYTES + 1,
  })
  const result = downscaleConversationImage(codec, bytes(12_000_000), 'image/webp')
  expect(result.mediaType).toBe('image/jpeg')
  expect(drawn.at(-1)).toEqual({ width: 1568, height: 1045, encodedAs: 'jpeg', quality: 0.82 })
})

test('a picture that already fits is kept byte for byte', () => {
  const { codec, drawn } = standIn({ size: { width: 1200, height: 900 } })
  const original = bytes(200_000)
  const result = downscaleConversationImage(codec, original, 'image/gif')
  expect(result.bytes).toBe(original)
  expect(result.mediaType).toBe('image/gif')
  expect(drawn).toEqual([])
})

test('one small enough on the edge but over the ceiling is encoded again at its size', () => {
  const { codec, drawn } = standIn({ size: { width: 1500, height: 1500 } })
  const result = downscaleConversationImage(codec, bytes(MAX_ATTACHMENT_BYTES + 1), 'image/png')
  expect(result.bytes.byteLength).toBe(1000)
  expect(drawn).toEqual([{ width: 1500, height: 1500, encodedAs: 'png' }])
})

test('a picture the codec cannot read, or fails to encode, goes on as it came', () => {
  const original = bytes(6_000_000)
  expect(downscaleConversationImage(standIn({ size: null }).codec, original, 'image/webp').bytes).toBe(original)
  const throwing: ImageCodec = {
    decode: () => {
      throw new Error('corrupt')
    },
  }
  expect(downscaleConversationImage(throwing, original, 'image/png').bytes).toBe(original)
  const empty = standIn({ size: { width: 4000, height: 3000 }, jpegBytes: 0 })
  const kept = downscaleConversationImage(empty.codec, original, 'image/jpeg')
  expect(kept).toEqual({ bytes: original, mediaType: 'image/jpeg' })
})
