// Reading, sizing and validating the images a chat turn carries.

import {
  ATTACHABLE_IMAGE_TYPES as SHARED_ATTACHABLE_IMAGE_TYPES,
  ATTACHMENT_JPEG_QUALITY,
  ATTACHMENT_JPEG_SOURCE_QUALITY,
  MAX_ATTACHMENT_BYTES as SHARED_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN as SHARED_MAX_ATTACHMENTS_PER_TURN,
  scaledImageDimensions,
} from '../../../../../shared/conversation-attachments'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'

// ── Image attachments (D3/1774) ─────────────────────────────────────────────

// The three boundary limits are the shared declaration in
// src/shared/conversation-attachments.ts, which the send-turn IPC boundary
// enforces from the same constants (1810). Re-exported under the names this
// module's other consumers already import.
export const ATTACHABLE_IMAGE_TYPES: readonly string[] = SHARED_ATTACHABLE_IMAGE_TYPES
export const MAX_ATTACHMENT_BYTES = SHARED_MAX_ATTACHMENT_BYTES
export const MAX_ATTACHMENTS_PER_TURN = SHARED_MAX_ATTACHMENTS_PER_TURN
// The resampling policy is shared with main, which shrinks a paired device's
// uploads by the same rules (src/shared/conversation-attachments.ts).
export {
  ATTACHMENT_JPEG_QUALITY,
  MAX_ATTACHMENT_EDGE,
  scaledImageDimensions,
} from '../../../../../shared/conversation-attachments'

// Providers whose adapter actually composes image content blocks from a turn's
// `attachments` — the claude-agent harness today (T2/D3). Every other provider
// ignores the field, so the attach affordances stay hidden rather than offering
// a control whose payload goes nowhere. Widening this set is a deliberate pair
// with the matching provider change.
export const IMAGE_CAPABLE_PROVIDER_IDS = new Set(['claude-agent'])

export function providerAcceptsImages(providerId: string | undefined | null): boolean {
  return providerId !== undefined && providerId !== null && IMAGE_CAPABLE_PROVIDER_IDS.has(providerId)
}

export function isAttachableImageType(mediaType: string): boolean {
  return ATTACHABLE_IMAGE_TYPES.includes(mediaType)
}

// Decoded byte length of a base64 payload, without allocating the buffer.
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Why this file cannot join the turn, or null when it can. Type and count are
// knowable before the file is read; the byte ceiling is only decidable after
// downscaling, so it is checked there instead of here.
export function attachmentRejection(file: { name?: string; type: string }, currentCount: number): string | null {
  if (!isAttachableImageType(file.type)) {
    const named = file.name ? `${file.name} is not` : 'That file is not'
    return `${named} an image Claude can read. Attach a PNG, JPEG, WebP, or GIF.`
  }
  if (currentCount >= MAX_ATTACHMENTS_PER_TURN) {
    return `A message can carry at most ${MAX_ATTACHMENTS_PER_TURN} images.`
  }
  return null
}

// Split a `data:` URL into the pieces the IPC boundary wants: the media type
// and the raw base64 payload with no prefix. Returns null for anything that is
// not a base64 data URL.
export function splitImageDataUrl(dataUrl: string): { mediaType: string; dataBase64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const [, mediaType, dataBase64] = match
  if (!mediaType || !dataBase64) return null
  return { mediaType, dataBase64 }
}

export function readFileAsDataUrl(file: Blob & { name?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`))
    reader.readAsDataURL(file)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('That image could not be decoded.'))
    image.src = src
  })
}

// Read one picked/pasted/dropped file into a send-ready attachment, resampling
// it when it is larger than a vision model can use or than the IPC boundary
// accepts. Rejects with a message the composer shows verbatim — never a silent
// truncation or a half-sized image passed off as the original.
//
// Exported so the canvas/FileReader path can be exercised: the unit test
// stands in the image, the canvas's encoder and the FileReader.
export async function readImageAttachment(file: File, id: string): Promise<ConversationImageAttachment> {
  // Decoded from the file itself rather than from a data URL of it: a
  // screenshot is several megabytes, and base64-encoding all of it on the
  // renderer's thread only to measure it and draw it smaller froze the
  // composer for as long as that took.
  const source = URL.createObjectURL(file)
  try {
    const image = await loadImageElement(source)
    const target = scaledImageDimensions(image.naturalWidth, image.naturalHeight)
    const fits = file.size <= MAX_ATTACHMENT_BYTES
    const sameSize = target.width === image.naturalWidth && target.height === image.naturalHeight
    // An image that already fits both budgets ships byte-for-byte — notably an
    // animated GIF, which a canvas round-trip would flatten to one frame.
    if (fits && sameSize) {
      const original = splitImageDataUrl(await readFileAsDataUrl(file))
      if (!original) throw new Error(`Could not read ${file.name || 'the image'}.`)
      return {
        id,
        mediaType: original.mediaType,
        dataBase64: original.dataBase64,
        ...(file.name ? { name: file.name } : {}),
        byteLength: base64ByteLength(original.dataBase64),
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This window cannot resize images right now.')
    context.drawImage(image, 0, 0, target.width, target.height)

    // Keep the source encoding when it can hold the image; fall back to JPEG only
    // when the re-encode is still over budget (JPEG drops alpha, so it is the
    // second choice, not the default). Encoded off the main thread, measured as
    // bytes, and only the encoding that is sent is turned into base64.
    const preferredType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    let encoded = await canvasToBlob(
      canvas,
      preferredType,
      preferredType === 'image/jpeg' ? ATTACHMENT_JPEG_SOURCE_QUALITY : undefined,
    )
    if (encoded && encoded.size > MAX_ATTACHMENT_BYTES && preferredType !== 'image/jpeg') {
      encoded = await canvasToBlob(canvas, 'image/jpeg', ATTACHMENT_JPEG_QUALITY)
    }
    if (!encoded) throw new Error(`Could not prepare ${file.name || 'the image'} for sending.`)
    if (encoded.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${file.name || 'That image'} is still over ${formatAttachmentBytes(MAX_ATTACHMENT_BYTES)} after resizing.`,
      )
    }
    const payload = splitImageDataUrl(await readFileAsDataUrl(encoded).catch(() => ''))
    if (!payload) throw new Error(`Could not prepare ${file.name || 'the image'} for sending.`)
    return {
      id,
      mediaType: payload.mediaType,
      dataBase64: payload.dataBase64,
      ...(file.name ? { name: file.name } : {}),
      byteLength: base64ByteLength(payload.dataBase64),
    }
  } finally {
    URL.revokeObjectURL(source)
  }
}
