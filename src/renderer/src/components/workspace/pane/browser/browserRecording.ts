import type { BrowserPointerEvent, BrowserRecordingStart } from '../../../../../../shared/browser'
import { AGENT_CURSOR_LINGER_MS } from './agentCursor'

// Recording a browser tab, in the window that hosts it (main's half is
// `src/main/browser/recording-encoder.ts`).
//
// The guest's frames come from Chromium's own capture of its WebContents: this
// window asks `getDisplayMedia`, and main answers with the tab's frame as the
// source, so nothing else on screen is in the video and no screen-recording
// permission is involved. Each frame is drawn onto a canvas with the agent's
// cursor over it, from the same pointer events the pane's cursor overlay
// draws, because that overlay is this window's own DOM and not part of the
// guest. The canvas is a track again, and MediaRecorder encodes it to WebM.
//
// A page that does not repaint produces no frames, so while the cursor is
// moving or fading the last frame is drawn again with it. A tab out of view
// keeps painting while it records: its layer waits behind the app rather than
// outside the window (WorkspacePaneBody's `hiddenBrowserLayerStyle`), and main
// keeps the tab and this window unthrottled while Studio is in the background.

/** What MediaRecorder is asked for, in order. WebM only: its VP9 and VP8 encoders are in every build. */
export const RECORDING_MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const

/** MediaRecorder hands over a chunk about this often. */
const CHUNK_MS = 1_000
/** How long the first frame may take before the capture is called failed. */
const FIRST_FRAME_TIMEOUT_MS = 5_000
/** The cursor's arrow, the overlay's own (`AgentBrowserCursor.tsx`): a 16-unit path drawn at the icon size. */
const CURSOR_PATH = 'M2 1.5 L2 12.5 L5 9.8 L7.2 14.5 L9.4 13.5 L7.2 8.9 L11 8.9 Z'
const CURSOR_TIP = { x: 2, y: 1.5 }
/** The overlay draws the arrow at `--icon-md`. */
export const CURSOR_CSS_PX = 18
/** A click's ring grows and fades over this long. */
export const CLICK_PULSE_MS = 450
/** The cursor fades out over the end of its linger. */
const CURSOR_FADE_MS = 200

export type Rect = { x: number; y: number; width: number; height: number }

/** The first type MediaRecorder takes, or null when it takes none of them. */
export function chooseRecordingMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return RECORDING_MIME_TYPES.find((type) => isTypeSupported(type)) ?? null
}

/** `source` scaled to fit inside `target` whole, centred. */
export function containRect(
  source: { width: number; height: number },
  target: { width: number; height: number },
): Rect {
  if (source.width <= 0 || source.height <= 0) return { x: 0, y: 0, width: target.width, height: target.height }
  const scale = Math.min(target.width / source.width, target.height / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return { x: (target.width - width) / 2, y: (target.height - height) / 2, width, height }
}

export type CursorEvent = BrowserPointerEvent & { at: number }

export type CursorPose = {
  /** Where the arrow's tip is on the canvas. */
  x: number
  y: number
  /** Canvas pixels per CSS pixel of the page. */
  scale: number
  opacity: number
  /** A click's ring, while it shows. */
  pulse: { radius: number; opacity: number } | null
}

/**
 * Where the agent's cursor is drawn on a frame placed at `frame`, or null when
 * it is not drawn: no event yet, one older than the overlay's linger, or one
 * without the viewport size it needs to be placed.
 */
export function cursorPose(event: CursorEvent | null, now: number, frame: Rect): CursorPose | null {
  const viewport = event?.viewport
  if (!event || !viewport || viewport.width <= 0 || viewport.height <= 0) return null
  const age = Math.max(0, now - event.at)
  if (age > AGENT_CURSOR_LINGER_MS) return null
  const scale = frame.width / viewport.width
  const fadeFrom = AGENT_CURSOR_LINGER_MS - CURSOR_FADE_MS
  const opacity = age <= fadeFrom ? 1 : Math.max(0, 1 - (age - fadeFrom) / CURSOR_FADE_MS)
  const progress = age / CLICK_PULSE_MS
  return {
    x: frame.x + event.x * scale,
    y: frame.y + event.y * (frame.height / viewport.height),
    scale,
    opacity,
    pulse:
      event.kind === 'click' && progress < 1
        ? { radius: (6 + 14 * progress) * scale, opacity: 0.5 * (1 - progress) }
        : null,
  }
}

/** The toolbar's clock for a running recording: `0:07`, `1:30`. */
export function recordingClock(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export type RecordingTheme = { fill: string; stroke: string; pulse: string; backdrop: string }

/** The cursor's colours, the overlay's tokens read live. */
export function readRecordingTheme(): RecordingTheme {
  const style = getComputedStyle(document.documentElement)
  // Fallbacks are CSS system colours, never literals of our own.
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    fill: read('--accent-primary', 'Highlight'),
    stroke: read('--text-on-accent', 'HighlightText'),
    pulse: read('--accent-primary-soft', 'Highlight'),
    backdrop: read('--bg-app', 'Canvas'),
  }
}

function drawCursor(ctx: OffscreenCanvasRenderingContext2D, pose: CursorPose, theme: RecordingTheme): void {
  ctx.save()
  if (pose.pulse) {
    ctx.globalAlpha = pose.pulse.opacity
    ctx.fillStyle = theme.pulse
    ctx.beginPath()
    ctx.arc(pose.x, pose.y, pose.pulse.radius, 0, Math.PI * 2)
    ctx.fill()
  }
  const unit = (CURSOR_CSS_PX / 16) * pose.scale
  ctx.globalAlpha = pose.opacity
  ctx.translate(pose.x - CURSOR_TIP.x * unit, pose.y - CURSOR_TIP.y * unit)
  ctx.scale(unit, unit)
  const arrow = new Path2D(CURSOR_PATH)
  ctx.fillStyle = theme.fill
  ctx.fill(arrow)
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  ctx.strokeStyle = theme.stroke
  ctx.stroke(arrow)
  ctx.restore()
}

// Chromium's breakout-box classes; the DOM typings do not carry them yet.
type TrackProcessor = { readable: ReadableStream<VideoFrame> }
type TrackGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
type BreakoutBox = {
  MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor
  MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator
}

export type GuestRecordingIo = {
  /** One chunk of WebM, in order. */
  onChunk(bytes: Uint8Array): void
  /** The agent's pointer on this tab. */
  onPointer(listener: (event: BrowserPointerEvent) => void): () => void
  theme: RecordingTheme
}

export type GuestRecording = {
  mimeType: string
  width: number
  height: number
  /** Whether the agent's cursor is drawn in. */
  cursor: boolean
  /** Finish: the last chunk is handed over before `finished` settles. */
  stop(): void
  /** Settles once the recording is over (stopped, or the tab went away), after its last chunk. */
  finished: Promise<{ durationMs: number; error?: string }>
}

/**
 * Start recording this window's tab. Main has armed the grant that answers
 * this window's `getDisplayMedia` with the tab. Resolves once the first frame
 * is in and the encoder is running; rejects when the capture cannot start.
 */
export async function startGuestRecording(
  options: BrowserRecordingStart,
  io: GuestRecordingIo,
): Promise<GuestRecording> {
  const mimeType = chooseRecordingMimeType((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('This build cannot encode WebM video.')
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      frameRate: { ideal: options.frameRate, max: options.frameRate },
      width: { max: options.maxEdge },
      height: { max: options.maxEdge },
    },
  })
  const track = stream.getVideoTracks()[0]
  if (!track) {
    for (const other of stream.getTracks()) other.stop()
    throw new Error('The capture gave no video.')
  }

  const box = globalThis as unknown as BreakoutBox
  const canComposite = Boolean(options.cursor && box.MediaStreamTrackProcessor && box.MediaStreamTrackGenerator)
  const cleanups: Array<() => void> = [() => track.stop()]
  let recordedTrack: MediaStreamTrack = track
  let size: { width: number; height: number }

  if (canComposite) {
    const processor = new box.MediaStreamTrackProcessor!({ track })
    const generator = new box.MediaStreamTrackGenerator!({ kind: 'video' })
    const reader = processor.readable.getReader()
    const writer = generator.writable.getWriter()
    let canvas: OffscreenCanvas | null = null
    let ctx: OffscreenCanvasRenderingContext2D | null = null
    let latest: VideoFrame | null = null
    let pointer: CursorEvent | null = null
    let writing = false
    /** A frame came while one was being written: the newest is drawn once the write lands. */
    let behind = false
    let lastComposedAt = 0
    let ticker: ReturnType<typeof setInterval> | null = null
    const frameInterval = 1000 / options.frameRate

    const compose = (): void => {
      if (!canvas || !ctx || !latest) return
      // A frame still on its way to the encoder: the newest is drawn when it
      // lands, and any between are dropped, so a slow encoder never builds a
      // backlog and a page that then goes still still ends on its last state.
      if (writing) {
        behind = true
        return
      }
      const now = performance.now()
      const placed = containRect({ width: latest.displayWidth, height: latest.displayHeight }, canvas)
      ctx.fillStyle = io.theme.backdrop
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(latest, placed.x, placed.y, placed.width, placed.height)
      const pose = cursorPose(pointer, Date.now(), placed)
      if (pose) drawCursor(ctx, pose, io.theme)
      const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) })
      lastComposedAt = now
      writing = true
      writer
        .write(frame)
        .catch(() => undefined)
        .finally(() => {
          frame.close()
          writing = false
          if (behind) {
            behind = false
            compose()
          }
        })
      if (!pose && ticker) {
        clearInterval(ticker)
        ticker = null
      }
    }

    const firstFrame = new Promise<{ width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The tab gave no picture to record.')), FIRST_FRAME_TIMEOUT_MS)
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (!canvas) {
              canvas = new OffscreenCanvas(value.displayWidth, value.displayHeight)
              ctx = canvas.getContext('2d')
              clearTimeout(timer)
              resolve({ width: value.displayWidth, height: value.displayHeight })
            }
            latest?.close()
            latest = value
            compose()
          }
        } catch {
          // The capture ended under the reader; the track's `ended` says so.
        }
      })()
    })

    // A still page repaints nothing, so a moving or fading cursor is drawn
    // over the last frame on a timer, for as long as it shows.
    const offPointer = io.onPointer((event) => {
      pointer = { ...event, at: Date.now() }
      if (!ticker)
        ticker = setInterval(() => {
          if (performance.now() - lastComposedAt >= frameInterval) compose()
        }, frameInterval)
    })
    cleanups.push(
      offPointer,
      () => {
        if (ticker) clearInterval(ticker)
      },
      () => void reader.cancel().catch(() => undefined),
      () => generator.stop(),
      () => latest?.close(),
    )
    try {
      size = await firstFrame
    } catch (error) {
      for (const cleanup of cleanups) cleanup()
      throw error
    }
    recordedTrack = generator
  } else {
    const settings = track.getSettings()
    size = { width: settings.width ?? 0, height: settings.height ?? 0 }
  }

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(new MediaStream([recordedTrack]), {
      mimeType,
      videoBitsPerSecond: options.bitsPerSecond,
    })
  } catch (failure) {
    // The capture is running; nothing will record it, so it stops here.
    for (const cleanup of cleanups) cleanup()
    throw failure
  }
  let error: string | undefined
  const stop = (): void => {
    if (recorder.state !== 'inactive') recorder.stop()
  }
  // Each chunk is read out in the order it came, so the file is in order. A
  // chunk that cannot be read leaves a hole no later chunk can follow (the
  // WebM after it would not play), so the recording ends there, saying why,
  // with what came before it kept.
  let handedOver: Promise<void> = Promise.resolve()
  let chunkLost = false
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size === 0) return
    const blob = event.data
    handedOver = handedOver.then(async () => {
      if (chunkLost) return
      try {
        io.onChunk(new Uint8Array(await blob.arrayBuffer()))
      } catch (failure) {
        chunkLost = true
        const reason = failure instanceof Error ? failure.message : String(failure)
        error ??= reason
          ? `A piece of the video could not be read: ${reason}`
          : 'A piece of the video could not be read.'
        stop()
      }
    })
  }
  const startedAt = performance.now()
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.onerror = (event: Event) => {
    const reason = (event as Event & { error?: { message?: string } }).error?.message
    error = reason ? `The encoder failed: ${reason}` : 'The encoder failed.'
    stop()
  }
  // The guest went away (the tab closed, or its page crashed).
  track.addEventListener('ended', () => {
    error ??= 'The tab stopped being captured.'
    stop()
  })
  try {
    recorder.start(CHUNK_MS)
  } catch (failure) {
    for (const cleanup of cleanups) cleanup()
    throw failure
  }

  const finished = (async () => {
    await stopped
    const durationMs = Math.round(performance.now() - startedAt)
    await handedOver.catch(() => undefined)
    for (const cleanup of cleanups) cleanup()
    return { durationMs, ...(error ? { error } : {}) }
  })()

  return { mimeType, width: size.width, height: size.height, cursor: canComposite, stop, finished }
}
