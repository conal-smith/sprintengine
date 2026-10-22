import { describe, expect, test } from 'vitest'

import { gifHeader, jpegHeader, pngHeader, webpVp8xHeader } from '../../tests/image-headers'
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, imageDimensions, imageWithinDecodeLimits } from './image-dimensions'

describe('a picture is measured by its header', () => {
  test.each([
    ['png', pngHeader],
    ['jpeg', jpegHeader],
    ['gif', gifHeader],
    ['webp', webpVp8xHeader],
  ])('%s', (_name, header) => {
    expect(imageDimensions(header(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(imageWithinDecodeLimits(header(4032, 3024))).toBe(true)
    expect(imageWithinDecodeLimits(header(IMAGE_MAX_SIDE + 1, 10))).toBe(false)
    expect(imageWithinDecodeLimits(header(10, IMAGE_MAX_SIDE + 1))).toBe(false)
  })

  test('a picture over 100 megapixels is refused though neither side is over the limit', () => {
    expect(12_000 * 12_000).toBeGreaterThan(IMAGE_MAX_PIXELS)
    expect(imageWithinDecodeLimits(pngHeader(12_000, 12_000))).toBe(false)
    expect(imageWithinDecodeLimits(pngHeader(100_000, 100_000))).toBe(false)
  })

  test('bytes that declare no size are left to the decoder', () => {
    expect(imageWithinDecodeLimits(new Uint8Array([1, 2, 3]))).toBe(true)
    expect(imageWithinDecodeLimits(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  })
})
