// Charts, tables and annotated drawings an agent writes into a reply as a
// ```visual fence: static HTML with inline SVG and CSS, shown in a frame of
// its own (`VisualFrame`) in place of the fence's source.
//
// The source is an agent's text, and like a diagram it must not run anything,
// navigate the app or load anything from outside the reply: a fetched image,
// stylesheet or font tells whoever serves it that the reply was read, and
// when. Three layers, each enough on its own for scripts: the markup is
// sanitized here (no scripts, handlers, frames, forms or links out, and every
// CSS fetch made inert as a diagram's is, `withoutRemoteCss`); the document it
// goes into carries the policy that refuses every load (`inertHtml`); and the
// frame that shows it is sandboxed with scripts off. A visual that brings its
// own <script> takes the other road, a sealed frame with scripts on and no
// origin (`shared/sealed-visual-document.ts`); this one is for everything else.
//
// A visual is drawn in the window's colours. Its document opens with a short
// set of variables taken from the app's semantic tokens (`VISUAL_VARIABLES`),
// which the agents are told to colour with, so one source reads in light and
// dark and in every theme. Like a diagram it is built per appearance, and
// built again when the appearance changes.

import { withoutRemoteCss } from '../diagram/mermaidDiagram'
import { inertHtml } from '../../utils/inertHtml'
import {
  baseStylesheet,
  MAX_VISUAL_SOURCE,
  VISUAL_EMPTY,
  VISUAL_TOO_LARGE,
  visualThemeFrom,
  type VisualTheme,
} from '../../../../shared/visual-document'

type Purify = typeof import('dompurify').default

let engine: Promise<Purify> | null = null

// Loaded with the first visual, never with the app. A failed load is
// forgotten, so the next visual, or a Retry, asks again.
function loadPurify(): Promise<Purify> {
  engine ??= import('dompurify').then(
    (module) => module.default,
    (error: unknown) => {
      engine = null
      throw error
    },
  )
  return engine
}

/** A document to show, with a name for the frame; or why there is none. `retry` marks a renderer that did not load. */
export type VisualResult = { html: string; title: string } | { error: string; retry?: boolean }

/** The current appearance, read from the document root's computed tokens. */
export function readVisualTheme(): VisualTheme {
  const style = getComputedStyle(document.documentElement)
  return visualThemeFrom((property) => style.getPropertyValue(property))
}

// Elements that run, load, frame, submit or play, whatever the profiles
// allow. Links are kept as text: their addresses are taken off below.
const FORBIDDEN_TAGS = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'audio',
  'video',
  'source',
  'track',
  'foreignObject',
]
const FORBIDDEN_ATTRIBUTES = ['srcset', 'action', 'formaction', 'ping', 'target', 'background', 'poster']

// An address a visual may keep: one of its own elements (`<use href="#tick">`)
// or a picture carried in it.
const OWN_FRAGMENT = /^\s*#/u
const INLINE_PICTURE = /^\s*data:image\//iu

let visualPurifier: ReturnType<Purify> | null = null

function purifier(purify: Purify): ReturnType<Purify> {
  if (visualPurifier) return visualPurifier
  const instance = purify(window)
  instance.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = withoutRemoteCss(node.textContent)
  })
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase()
    const value = data.attrValue ?? ''
    if (name === 'href' || name === 'xlink:href') {
      // A link anywhere is text; a reference to the visual's own elements, or
      // a picture an `<image>` carries, stays.
      const tag = node.nodeName.toLowerCase()
      data.keepAttr = tag !== 'a' && (OWN_FRAGMENT.test(value) || (tag === 'image' && INLINE_PICTURE.test(value)))
      return
    }
    if (name === 'src') {
      data.keepAttr = INLINE_PICTURE.test(value)
      return
    }
    // Any attribute, not only `style`: SVG paints with `fill="url(…)"` too.
    if (value) data.attrValue = withoutRemoteCss(value)
  })
  visualPurifier = instance
  return instance
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * The document a ```visual fence is shown as: its markup sanitized, under the
 * inert policy, the base stylesheet and the theme's variables. A fragment or
 * a whole document is taken; of a document's head only its stylesheets are
 * kept. A source too large, or with nothing left to draw once sanitized, is
 * refused, and shows as source.
 */
export function buildVisualDocument(purify: Purify, source: string, theme: VisualTheme): VisualResult {
  if (source.length > MAX_VISUAL_SOURCE) return { error: VISUAL_TOO_LARGE }
  const root = purifier(purify).sanitize(source, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    // A repeated mark (a tick, a legend swatch) drawn once and placed many
    // times. Left out of the profile for what it can point at; here it can
    // point only at the visual's own elements (the hook above).
    ADD_TAGS: ['use'],
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  }) as HTMLElement | null
  const head = root?.querySelector('head')
  const body = root?.querySelector('body')
  if (!body || (!textOf(body) && !body.querySelector('svg, img'))) return { error: VISUAL_EMPTY }
  const styles = [...(head?.querySelectorAll('style') ?? [])].map((style) => style.outerHTML).join('')
  const title =
    textOf(head?.querySelector('title')) ||
    textOf(body.querySelector('h1, h2, h3, h4, h5, h6, figcaption, caption, svg > title')) ||
    'Visual'
  const html = inertHtml(
    `<!doctype html><html><head><style>${baseStylesheet(theme)}</style>${styles}</head><body>${body.innerHTML}</body></html>`,
  )
  return { html, title: title.length > 120 ? `${title.slice(0, 119)}…` : title }
}

// ---- Built once per appearance and source ---------------------------------

// Bounded, least recently used out, as diagrams are.
const MAX_CACHED = 32
const cache = new Map<string, VisualResult>()

function cacheKey(appearance: string, source: string): string {
  return `${appearance}\0${source}`
}

/** The visual already built for this appearance and source, if there is one. */
export function cachedVisual(appearance: string, source: string): VisualResult | undefined {
  const key = cacheKey(appearance, source)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function remember(key: string, result: VisualResult): void {
  cache.set(key, result)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
}

/**
 * Builds a visual for the window's current appearance. A refusal is kept like
 * a document is; a sanitizer that did not load is not, so the next visual, or
 * a Retry, asks for it again.
 */
export async function drawVisual(appearance: string, source: string): Promise<VisualResult> {
  const hit = cachedVisual(appearance, source)
  if (hit) return hit
  const key = cacheKey(appearance, source)
  if (source.length > MAX_VISUAL_SOURCE) {
    const refused = { error: VISUAL_TOO_LARGE }
    remember(key, refused)
    return refused
  }
  const purify = await loadPurify().catch(() => null)
  if (!purify) return { error: 'the visual renderer could not be loaded', retry: true }
  const result = buildVisualDocument(purify, source, readVisualTheme())
  remember(key, result)
  return result
}
