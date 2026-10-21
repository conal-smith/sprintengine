import type { DOMWindow } from 'jsdom'

// jsdom decodes no image and draws on no canvas, and a composer reads every
// image it stages through both (agentChat/imageAttachments.ts). These stand
// them in: an image decodes at `decoded`'s size, and a canvas records the size
// it is drawn at and encodes to `encodedBytes` bytes of the type asked for.

export type ImageDecodingStandIn = {
  /** The size the next image decodes at. Small enough to send as it is, until a test says otherwise. */
  decoded: { width: number; height: number }
  /** What an encode of a resampled image weighs. */
  encodedBytes: number
  /** The size of each canvas an image was drawn on, in order. */
  drawn: Array<{ width: number; height: number }>
}

export function standInImageDecoding(window: DOMWindow): ImageDecodingStandIn {
  const standIn: ImageDecodingStandIn = { decoded: { width: 400, height: 300 }, encodedBytes: 1024, drawn: [] }
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.Image = class StandInImage {
    naturalWidth = standIn.decoded.width
    naturalHeight = standIn.decoded.height
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      setTimeout(() => this.onload?.())
    }
  }
  URL.createObjectURL = () => 'blob:stand-in'
  URL.revokeObjectURL = () => {}
  const canvas = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  canvas.getContext = function getContext(this: HTMLCanvasElement) {
    return {
      drawImage: () => {
        standIn.drawn.push({ width: this.width, height: this.height })
      },
    }
  }
  canvas.toBlob = (callback: (blob: Blob | null) => void, type: string) => {
    setTimeout(() => callback(new window.Blob([new Uint8Array(standIn.encodedBytes)], { type })))
  }
  return standIn
}
