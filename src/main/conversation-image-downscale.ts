import {
  ATTACHMENT_JPEG_QUALITY,
  ATTACHMENT_JPEG_SOURCE_QUALITY,
  MAX_ATTACHMENT_BYTES,
  scaledImageDimensions,
} from '../shared/conversation-attachments'
import { imageWithinDecodeLimits } from '../shared/image-dimensions'

/**
 * A picture a paired device uploaded, sized for the model before it reaches it.
 *
 * The composer here shrinks every image it stages to a 1568px long edge in the
 * renderer (agentChat/imageAttachments.ts). A phone's photo came in over the
 * tailnet and went to the model as it was taken, and Claude refuses an image
 * over 2000px a side once a thread holds more than 20 images: from then on
 * every turn of that chat failed. So the desktop shrinks an upload on receipt,
 * by the composer's own rules, which live in src/shared/conversation-attachments.ts:
 *
 * - one that already fits both the edge and the byte ceiling stays byte for
 *   byte (an animated GIF would lose its frames to a re-encode);
 * - otherwise it is resampled to the long edge and kept a JPEG if it was one,
 *   a PNG otherwise, and made a JPEG only when the PNG is still over the
 *   ceiling;
 * - one that cannot be decoded (`nativeImage` reads PNG and JPEG only) stays
 *   as it came, for the ceiling to decide.
 *
 * The decoder is handed in, so the rules are tested without Electron; the app
 * binds `nativeImage` (conversation-image-codec-electron.ts).
 */

export type DecodedImage = {
  width: number
  height: number
  /** The image drawn at this size. */
  resize(width: number, height: number): DecodedImage
  png(): Uint8Array
  /** `quality` 0 to 1, as a canvas takes it. */
  jpeg(quality: number): Uint8Array
}

export type ImageCodec = {
  /** The image, or null when the bytes are not one this codec can read. */
  decode(bytes: Uint8Array): DecodedImage | null
}

export type DownscaledImage = { bytes: Uint8Array; mediaType: string }

export type ConversationImageDownscaler = (bytes: Uint8Array, mediaType: string) => Promise<DownscaledImage>

export function downscaleConversationImage(codec: ImageCodec, bytes: Uint8Array, mediaType: string): DownscaledImage {
  const original = { bytes, mediaType }
  // A picture whose header declares more than a decoder should allocate is
  // not decoded here, whichever codec was handed in.
  if (!imageWithinDecodeLimits(bytes)) return original
  let image: DecodedImage | null
  try {
    image = codec.decode(bytes)
  } catch {
    return original
  }
  if (!image || image.width < 1 || image.height < 1) return original
  const target = scaledImageDimensions(image.width, image.height)
  const sameSize = target.width === image.width && target.height === image.height
  if (sameSize && bytes.byteLength <= MAX_ATTACHMENT_BYTES) return original
  // An encoder that gives nothing back failed as surely as one that threw.
  const encoded = (out: Uint8Array, type: string): DownscaledImage =>
    out.byteLength > 0 ? { bytes: out, mediaType: type } : original
  try {
    const resized = sameSize ? image : image.resize(target.width, target.height)
    if (mediaType === 'image/jpeg') return encoded(resized.jpeg(ATTACHMENT_JPEG_SOURCE_QUALITY), 'image/jpeg')
    const png = resized.png()
    if (png.byteLength > 0 && png.byteLength <= MAX_ATTACHMENT_BYTES) return { bytes: png, mediaType: 'image/png' }
    return encoded(resized.jpeg(ATTACHMENT_JPEG_QUALITY), 'image/jpeg')
  } catch {
    return original
  }
}
