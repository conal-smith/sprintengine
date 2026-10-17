import { nativeImage, type NativeImage } from 'electron'

import type { DecodedImage, ImageCodec } from './conversation-image-downscale'

// The image codec main has: Electron's `nativeImage`. It decodes PNG and JPEG,
// which is what a phone's camera and screenshots send; a WebP or a GIF comes
// back empty and goes on as it came (Electron 44, 2026-10-17). Kept apart from
// the downscale rules so those are tested without an Electron runtime. Main
// process only: a utility process has no `nativeImage`, and asks the shell
// instead (the shell bridge's `images`). Synchronous on main's thread: a
// 4032x3024 photo takes a few hundred milliseconds, once, on receipt.

function decoded(image: NativeImage): DecodedImage {
  const { width, height } = image.getSize()
  return {
    width,
    height,
    resize: (nextWidth, nextHeight) => decoded(image.resize({ width: nextWidth, height: nextHeight, quality: 'best' })),
    png: () => new Uint8Array(image.toPNG()),
    jpeg: (quality) => new Uint8Array(image.toJPEG(Math.round(quality * 100))),
  }
}

export const electronImageCodec: ImageCodec = {
  decode(bytes) {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    return image.isEmpty() ? null : decoded(image)
  },
}
