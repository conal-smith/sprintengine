// Image-attachment limits for a conversation turn, declared once for both ends
// of the send-turn boundary: the composer stages against them
// (src/renderer/src/components/panels/AgentChatView.tsx) and
// `parseImageAttachments` rejects against them
// (src/main/ipc/conversation-ipc.ts). They were independently declared on each
// side; drift showed up as the composer staging an image the boundary then
// refused mid-send, or trimming to a cap main had already raised (1810).
//
// Node-free on purpose — this module is imported from the renderer and main.
// The resampling policy (longest kept edge, the encodings and their quality)
// is here too, though no boundary enforces it: the composer shrinks an image
// with it in the renderer, and the desktop shrinks a paired device's upload
// with it in main (src/main/conversation-image-downscale.ts), so a picture
// reaches the model the same size whichever way it came.

// The base64 image media types the Claude Agent SDK (and the Anthropic API)
// accept. Offering anything else in the composer would only buy the user a
// rejection one layer down.
export const ATTACHABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

// Per-image decoded-byte ceiling, matching the Anthropic API's ~5 MB image
// limit. The composer downscales toward it and only refuses what still will not
// fit; the boundary rejects the rest so nothing silently truncates.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// Per-turn attachment cap: generous enough that no realistic manual attach
// count reaches it, low enough that a runaway paste cannot push an unbounded
// payload through IPC.
export const MAX_ATTACHMENTS_PER_TURN = 16

// Longest edge kept when an image is resampled. Vision models stop gaining
// detail past ~1568px on the long edge, so this is the token-cost choice as
// much as the size guard. It also keeps every picture under the 2000px a side
// Claude refuses once a thread holds more than 20 images.
export const MAX_ATTACHMENT_EDGE = 1568

// Re-encode quality for the JPEG fallback used when a resampled image is still
// over the byte ceiling.
export const ATTACHMENT_JPEG_QUALITY = 0.82

// The quality a JPEG is re-encoded at when it was a JPEG to begin with: a
// canvas's own default, which is what the composer has always encoded at.
export const ATTACHMENT_JPEG_SOURCE_QUALITY = 0.92

// What a paired device may upload where the desktop shrinks each picture on
// receipt (the `conversation-image-downscale` capability): a phone's camera
// photo is often over the per-image ceiling before it is resized, and under
// it after. What reaches the model is still held to MAX_ATTACHMENT_BYTES.
export const MAX_DOWNSCALED_UPLOAD_BYTES = 20 * 1024 * 1024

// Longest-edge-constrained target size, aspect ratio preserved. An image that
// already fits comes back untouched so small images are never resampled (which
// would re-encode them for no gain).
export function scaledImageDimensions(
  width: number,
  height: number,
  maxEdge = MAX_ATTACHMENT_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
