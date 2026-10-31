// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { SEALED_VISUAL_URL_PREFIX } from '../../shared/sealed-visual'
import { SEALED_VISUAL_POLICY } from '../../shared/sealed-visual-document'
import { MAX_VISUAL_SOURCE, VISUAL_FRAME_MAX_HEIGHT } from '../../shared/visual-document'
import {
  PREVIEW_MAX_CONSOLE_LINE_CHARS,
  PREVIEW_MAX_CONSOLE_LINES,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewVisual,
  previewWidth,
  type VisualConsoleLine,
  type VisualPreviewDeps,
  type VisualPreviewSurface,
} from './visual-preview'

type FakeFrame = { loaded: boolean; height: number | null; console?: VisualConsoleLine[] }

// A window that runs the parts script for real (jsdom has the parser main
// lacks) and answers the frame script with what the test says the frame did.
function fakeDeps(frame: FakeFrame, options: { png?: number; jpeg?: number; openDelayMs?: number } = {}) {
  const seen = { scripts: [] as string[], sizes: [] as Array<[number, number]>, closed: 0, url: '' }
  const lines: VisualConsoleLine[] = []
  const surface: VisualPreviewSurface = {
    run: async (script) => {
      seen.scripts.push(script)
      if (script.startsWith('(function readVisualParts') || script.includes('DOMParser')) {
        return new Function(`return ${script}`)()
      }
      if (script.includes('__visualPreviewFrame = frame')) {
        seen.url = JSON.parse(/frame\.src = ("(?:[^"\\]|\\.)*");/u.exec(script)![1]!) as string
        lines.push(...(frame.console ?? []))
        return { loaded: frame.loaded, height: frame.height }
      }
      return true
    },
    consoleLines: () => [...lines],
    resize: (width, height) => seen.sizes.push([width, height]),
    capture: async () => ({
      width: 640,
      height: 100,
      png: () => Buffer.alloc(options.png ?? 10, 1),
      jpeg: () => Buffer.alloc(options.jpeg ?? 5, 2),
    }),
    close: () => {
      seen.closed += 1
    },
  }
  const deps: VisualPreviewDeps = {
    open: async (width, height) => {
      seen.sizes.push([width, height])
      if (options.openDelayMs) await new Promise((resolve) => setTimeout(resolve, options.openDelayMs))
      return surface
    },
    theme: async () => ({ theme: { variables: { '--fg': 'rgb(1, 2, 3)' }, colorScheme: 'dark' }, background: '#111' }),
  }
  return { deps, seen }
}

const chart = `<h3>Latency by region</h3><svg height="120"><rect width="10" height="10" fill="var(--chart-1)"/></svg>
<script>document.querySelector('rect').addEventListener('click', () => {})</script>`

test('a visual is built into the sealed document the chat loads, in the app theme', async () => {
  const { deps, seen } = fakeDeps({ loaded: true, height: 180 })
  const outcome = await previewVisual(deps, { source: chart })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.value).toMatchObject({
    title: 'Latency by region',
    scripted: true,
    width: 640,
    contentHeight: 180,
    frameHeight: 180,
    clipped: false,
    loaded: true,
    image: { mimeType: 'image/png' },
  })
  expect(seen.url.startsWith(SEALED_VISUAL_URL_PREFIX)).toBe(true)
  const html = decodeURIComponent(seen.url.slice(SEALED_VISUAL_URL_PREFIX.length))
  expect(html).toContain(SEALED_VISUAL_POLICY)
  expect(html).toContain('--fg: rgb(1, 2, 3);')
  expect(html).toContain('color-scheme: dark;')
  // The frame has the chat's sandbox and nothing more.
  const frameScript = seen.scripts.find((script) => script.includes('__visualPreviewFrame = frame'))!
  expect(frameScript).toContain("frame.setAttribute('sandbox', 'allow-scripts')")
  expect(frameScript).not.toContain('allow-same-origin')
  // The window is sized to the frame before the capture, and closed after.
  expect(seen.sizes.at(-1)).toEqual([640, 180])
  expect(seen.closed).toBe(1)
})

test('what the visual printed and threw comes back, refused loads included', async () => {
  const { deps } = fakeDeps({
    loaded: true,
    height: 90,
    console: [
      { level: 'info', message: 'drawn 3 bars' },
      { level: 'error', message: 'Uncaught TypeError: bars.map is not a function', line: 4 },
      {
        level: 'error',
        message:
          "Refused to connect to 'https://example.com/data.json' because it violates the Content Security Policy",
      },
    ],
  })
  const outcome = await previewVisual(deps, { source: chart })
  expect(outcome.ok && outcome.value.console.map((line) => line.level)).toEqual(['info', 'error', 'error'])
  expect(outcome.ok && outcome.value.console[1]).toEqual({
    level: 'error',
    message: 'Uncaught TypeError: bars.map is not a function',
    line: 4,
  })
})

test('a tall visual is reported clipped at the frame cap, and the window is no taller', async () => {
  const { deps, seen } = fakeDeps({ loaded: true, height: 2400 })
  const outcome = await previewVisual(deps, { source: chart })
  expect(outcome.ok && outcome.value).toMatchObject({
    contentHeight: 2400,
    frameHeight: VISUAL_FRAME_MAX_HEIGHT,
    clipped: true,
  })
  expect(seen.sizes.at(-1)).toEqual([640, VISUAL_FRAME_MAX_HEIGHT])
})

test('a visual that never loads or reports is said so, at the reserved height', async () => {
  const { deps } = fakeDeps({ loaded: false, height: null })
  const outcome = await previewVisual(deps, { source: '<p>hello</p>' })
  expect(outcome.ok && outcome.value).toMatchObject({ loaded: false, contentHeight: null, scripted: false })
})

test('the width is kept inside its limits', () => {
  expect(previewWidth(undefined)).toBe(640)
  expect(previewWidth(10)).toBe(PREVIEW_MIN_WIDTH)
  expect(previewWidth(99_999)).toBe(PREVIEW_MAX_WIDTH)
  expect(previewWidth(Number.NaN)).toBe(640)
  expect(previewWidth(801.4)).toBe(801)
})

test('an oversized or empty visual is refused, and no window is opened for one too large', async () => {
  const { deps, seen } = fakeDeps({ loaded: true, height: 10 })
  const large = await previewVisual(deps, { source: `<p>${'x'.repeat(MAX_VISUAL_SOURCE)}</p>` })
  expect(large).toMatchObject({ ok: false, code: 'too_large' })
  expect(seen.sizes).toEqual([])
  const empty = await previewVisual(deps, { source: '<link rel="stylesheet" href="https://example.com/x.css">' })
  expect(empty).toMatchObject({ ok: false, code: 'empty' })
  expect(seen.closed).toBe(1)
})

test('the console is capped in lines and in length', async () => {
  const many = Array.from({ length: PREVIEW_MAX_CONSOLE_LINES + 7 }, (_, index) => ({
    level: 'info' as const,
    message: index === 0 ? 'y'.repeat(5000) : `line ${index}`,
  }))
  const { deps } = fakeDeps({ loaded: true, height: 50, console: many })
  const outcome = await previewVisual(deps, { source: chart })
  expect(outcome.ok && outcome.value.console.length).toBe(PREVIEW_MAX_CONSOLE_LINES)
  expect(outcome.ok && outcome.value.consoleOmitted).toBe(7)
  expect(outcome.ok && outcome.value.console[0]!.message.length).toBe(PREVIEW_MAX_CONSOLE_LINE_CHARS)
})

test('a picture over the budget falls back to JPEG, then to none', async () => {
  const jpeg = await previewVisual(fakeDeps({ loaded: true, height: 50 }, { png: 700 * 1024 }).deps, { source: chart })
  expect(jpeg.ok && jpeg.value.image?.mimeType).toBe('image/jpeg')
  const none = await previewVisual(
    fakeDeps({ loaded: true, height: 50 }, { png: 700 * 1024, jpeg: 1024 * 1024 }).deps,
    {
      source: chart,
    },
  )
  expect(none.ok && none.value.image).toBeNull()
  expect(none.ok && none.value.imageNote).toMatch(/too large/u)
})

test('a preview past its time limit gives up, and the late window is closed', async () => {
  const { deps, seen } = fakeDeps({ loaded: true, height: 50 }, { openDelayMs: 60 })
  const outcome = await previewVisual(deps, { source: chart }, 20)
  expect(outcome).toMatchObject({ ok: false, code: 'timed_out' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(seen.closed).toBe(1)
})
