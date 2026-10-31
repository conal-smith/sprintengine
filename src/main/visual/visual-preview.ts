import {
  asVisualParts,
  assembleScriptedVisualDocument,
  hasVisualScript,
  visualPartsScript,
} from '../../shared/sealed-visual-document'
import { SEALED_VISUAL_CHANNEL } from '../../shared/sealed-visual'
import {
  MAX_VISUAL_SOURCE,
  VISUAL_FRAME_MAX_HEIGHT,
  VISUAL_TOO_LARGE,
  type VisualTheme,
} from '../../shared/visual-document'

// An agent's look at a ```visual block before it posts it: the block is built
// into the same sealed document the chat builds (`sealed-visual-document.ts`),
// loaded into a frame with the chat's sandbox in a hidden window, and the
// agent gets back what the person would see: a picture, the height the frame
// would take, and what the visual's scripts printed or threw.
//
// The window is behind `VisualPreviewSurface`, so the steps and their limits
// are tested here without one; `visual-preview-window.ts` is the Electron side.

/** A line a visual printed to its console, or an error it threw. */
export type VisualConsoleLine = { level: 'debug' | 'info' | 'warning' | 'error'; message: string; line?: number }

/** A captured picture, encodable on demand. */
export type VisualCapture = { width: number; height: number; png(): Buffer; jpeg(quality: number): Buffer }

/** The hidden window a preview runs in: a blank host page the sealed frame is put into. */
export type VisualPreviewSurface = {
  /** Runs a script in the host page and resolves its value. */
  run(script: string): Promise<unknown>
  /** What the page and its frame have printed so far, oldest first. */
  consoleLines(): VisualConsoleLine[]
  /** Sizes the window's content. */
  resize(width: number, height: number): void
  capture(): Promise<VisualCapture | null>
  close(): void
}

export type VisualPreviewDeps = {
  open(width: number, height: number): Promise<VisualPreviewSurface>
  /** The app's current appearance, and the colour the reply sits on. */
  theme(): Promise<{ theme: VisualTheme; background: string | null }>
}

export type VisualPreviewRequest = { source: string; width?: number }

export type VisualPreview = {
  title: string
  /** Whether the chat runs this visual's scripts; one without a script is drawn with scripts off. */
  scripted: boolean
  /** The frame's width in CSS pixels. */
  width: number
  /** The content's height as the visual reported it, or null when it reported none. */
  contentHeight: number | null
  /** The height the chat's frame takes: the content's, up to the cap. */
  frameHeight: number
  /** Whether the content is taller than the frame, so the person sees it cut off. */
  clipped: boolean
  /** Whether the frame finished loading inside the time limit. */
  loaded: boolean
  console: VisualConsoleLine[]
  /** Lines left out past the limit. */
  consoleOmitted: number
  image: { data: string; mimeType: 'image/png' | 'image/jpeg' } | null
  /** Why there is no picture, when there is none. */
  imageNote?: string
}

export type VisualPreviewOutcome = { ok: true; value: VisualPreview } | { ok: false; code: string; message: string }

export const PREVIEW_DEFAULT_WIDTH = 640
export const PREVIEW_MIN_WIDTH = 240
export const PREVIEW_MAX_WIDTH = 1200
/** What the chat's frame holds before a visual reports its height. */
const RESERVED_HEIGHT = 160
/** How long the frame may take to load. */
export const PREVIEW_LOAD_TIMEOUT_MS = 8_000
/** After load, for a first render, fonts and a script's first timers. */
const SETTLE_MS = 400
/** The whole preview, window included; past this it is abandoned. */
export const PREVIEW_TOTAL_TIMEOUT_MS = 20_000
export const PREVIEW_MAX_CONSOLE_LINES = 50
export const PREVIEW_MAX_CONSOLE_LINE_CHARS = 500
// A result is one line on the gateway socket; the picture is the bulk of it.
const PNG_BUDGET = 600 * 1024
const JPEG_BUDGET = 900 * 1024
const JPEG_QUALITY = 80

/** The frame's width for a requested one: the default when none, inside the limits otherwise. */
export function previewWidth(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return PREVIEW_DEFAULT_WIDTH
  return Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, Math.round(requested)))
}

// A CSS colour into a style attribute: anything that could leave the value is refused.
function safeColour(value: string | null): string {
  return value && !/[<>{};"'\\]/u.test(value) ? value : 'transparent'
}

/**
 * The host page's half: a frame with the chat's sandbox (`SEALED_VISUAL_SANDBOX`,
 * scripts and nothing else), the last height the visual reported from that
 * frame alone, and an answer once it has loaded and settled or the load
 * limit has passed.
 */
export function frameScript(url: string, background: string | null): string {
  return `new Promise(function (resolve) {
  var channel = ${JSON.stringify(SEALED_VISUAL_CHANNEL)}, height = null, loaded = false, done = false;
  document.documentElement.style.background = ${JSON.stringify(safeColour(background))};
  document.body.style.margin = '0';
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.cssText = 'display:block;border:0;width:100%;height:${RESERVED_HEIGHT}px;background:transparent';
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== frame.contentWindow || !data || data.channel !== channel || data.type !== 'height') return;
    if (typeof data.height === 'number' && isFinite(data.height) && data.height > 0) height = data.height;
  });
  function finish() { if (done) return; done = true; resolve({ loaded: loaded, height: height }); }
  frame.addEventListener('load', function () { loaded = true; setTimeout(finish, ${SETTLE_MS}); });
  setTimeout(finish, ${PREVIEW_LOAD_TIMEOUT_MS});
  window.__visualPreviewFrame = frame;
  frame.src = ${JSON.stringify(url)};
  document.body.appendChild(frame);
})`
}

/** Sets the frame to the height the chat would give it, and waits for that to paint. */
export function sizeScript(height: number): string {
  return `new Promise(function (resolve) {
  var frame = window.__visualPreviewFrame;
  if (frame) frame.style.height = '${Math.round(height)}px';
  var settled = false;
  function finish() { if (!settled) { settled = true; resolve(true); } }
  requestAnimationFrame(function () { requestAnimationFrame(finish); });
  setTimeout(finish, 200);
})`
}

function readFrameState(value: unknown): { loaded: boolean; height: number | null } {
  const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const height = state.height
  return {
    loaded: state.loaded === true,
    height: typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.ceil(height) : null,
  }
}

/** The console as returned: each line cut to a length, and the list to a count. */
export function boundedConsole(lines: VisualConsoleLine[]): { console: VisualConsoleLine[]; omitted: number } {
  const kept = lines.slice(0, PREVIEW_MAX_CONSOLE_LINES).map((line) => ({
    ...line,
    message:
      line.message.length > PREVIEW_MAX_CONSOLE_LINE_CHARS
        ? `${line.message.slice(0, PREVIEW_MAX_CONSOLE_LINE_CHARS - 1)}…`
        : line.message,
  }))
  return { console: kept, omitted: Math.max(0, lines.length - kept.length) }
}

function encode(capture: VisualCapture): Pick<VisualPreview, 'image' | 'imageNote'> {
  const png = capture.png()
  if (png.length <= PNG_BUDGET) return { image: { data: png.toString('base64'), mimeType: 'image/png' } }
  const jpeg = capture.jpeg(JPEG_QUALITY)
  if (jpeg.length <= JPEG_BUDGET) return { image: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' } }
  return { image: null, imageNote: 'The picture was too large to return; try a narrower width.' }
}

function timeout(ms: number): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PreviewTimeout()), ms)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

class PreviewTimeout extends Error {}

/** Draws a visual as the chat would, in a window of its own, and reports what came out. */
export async function previewVisual(
  deps: VisualPreviewDeps,
  request: VisualPreviewRequest,
  totalTimeoutMs = PREVIEW_TOTAL_TIMEOUT_MS,
): Promise<VisualPreviewOutcome> {
  const source = request.source
  if (source.length > MAX_VISUAL_SOURCE) return { ok: false, code: 'too_large', message: `${VISUAL_TOO_LARGE}.` }
  const width = previewWidth(request.width)
  let surface: VisualPreviewSurface | null = null
  let finished = false
  const limit = timeout(totalTimeoutMs)
  const run = async (): Promise<VisualPreviewOutcome> => {
    const { theme, background } = await deps.theme()
    const opened = await deps.open(width, RESERVED_HEIGHT)
    // A window that opened after the time ran out is closed at once.
    if (finished) {
      opened.close()
      throw new PreviewTimeout()
    }
    surface = opened
    const parts = asVisualParts(await surface.run(visualPartsScript(source)))
    if (!parts) return { ok: false, code: 'render_failed', message: 'The visual could not be read.' }
    const built = assembleScriptedVisualDocument(parts, theme)
    if ('error' in built) return { ok: false, code: 'empty', message: `${built.error}.` }
    const state = readFrameState(await surface.run(frameScript(built.url, background)))
    const frameHeight = Math.min(state.height ?? RESERVED_HEIGHT, VISUAL_FRAME_MAX_HEIGHT)
    surface.resize(width, frameHeight)
    await surface.run(sizeScript(frameHeight))
    const capture = await surface.capture()
    const { console, omitted } = boundedConsole(surface.consoleLines())
    return {
      ok: true,
      value: {
        title: built.title,
        scripted: hasVisualScript(source),
        width,
        contentHeight: state.height,
        frameHeight,
        clipped: state.height !== null && state.height > VISUAL_FRAME_MAX_HEIGHT,
        loaded: state.loaded,
        console,
        consoleOmitted: omitted,
        ...(capture ? encode(capture) : { image: null, imageNote: 'The window gave no picture.' }),
      },
    }
  }
  try {
    return await Promise.race([run(), limit.promise])
  } catch (error) {
    if (error instanceof PreviewTimeout)
      return {
        ok: false,
        code: 'timed_out',
        message: `The preview did not finish within ${Math.round(totalTimeoutMs / 1000)} seconds.`,
      }
    return {
      ok: false,
      code: 'render_failed',
      message: `The preview failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    finished = true
    limit.cancel()
    // Typed through a local: TypeScript narrows the closure's assignment away.
    const opened = surface as VisualPreviewSurface | null
    opened?.close()
  }
}
