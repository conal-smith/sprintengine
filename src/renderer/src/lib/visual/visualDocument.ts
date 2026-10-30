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
// origin (`scriptedVisualDocument.ts`); this one is for everything else.
//
// A visual is drawn in the window's colours. Its document opens with a short
// set of variables taken from the app's semantic tokens (`VISUAL_VARIABLES`),
// which the agents are told to colour with, so one source reads in light and
// dark and in every theme. Like a diagram it is built per appearance, and
// built again when the appearance changes.

import { withoutRemoteCss } from '../diagram/mermaidDiagram'
import { inertHtml } from '../../utils/inertHtml'

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

/**
 * Past this a fence is shown as its source. A chart is a few kilobytes of
 * SVG; one this size is data pasted as markup, and building a frame of it on
 * every appearance change is not worth it.
 */
export const MAX_VISUAL_SOURCE = 256 * 1024

export const VISUAL_TOO_LARGE = 'the visual is larger than 256 KB'
export const VISUAL_EMPTY = 'the visual has nothing to draw'

/**
 * The names a visual colours and sets type with, and the semantic token each
 * is read from. Short, because an agent writes them; the agent instructions
 * (`VISUALS_INSTRUCTION`, `main/providers/visuals-guidance.ts`) name the same set.
 */
export const VISUAL_VARIABLES: Readonly<Record<string, string>> = {
  '--fg': '--sem-color-text-default',
  '--fg-strong': '--sem-color-text-primary',
  '--fg-muted': '--sem-color-text-muted',
  '--fg-subtle': '--sem-color-text-subtle',
  '--border': '--sem-color-border-default',
  '--border-subtle': '--sem-color-border-subtle',
  '--bg-subtle': '--sem-color-bg-well',
  '--accent': '--sem-color-accent-primary',
  '--positive': '--sem-color-status-good',
  '--negative': '--sem-color-status-danger',
  '--warning': '--sem-color-status-warn',
  '--chart-1': '--sem-color-chart-1',
  '--chart-2': '--sem-color-chart-2',
  '--chart-3': '--sem-color-chart-3',
  '--chart-4': '--sem-color-chart-4',
  '--chart-5': '--sem-color-chart-5',
  '--chart-6': '--sem-color-chart-6',
  '--chart-7': '--sem-color-chart-7',
  '--chart-8': '--sem-color-chart-8',
  '--chart-other': '--sem-color-chart-other',
  '--font': '--sem-font-family-ui',
  '--font-mono': '--sem-font-family-mono',
  '--font-size': '--sem-font-size-body',
  '--font-size-small': '--sem-font-size-meta',
  '--font-size-heading': '--sem-font-size-heading',
}

/** The window's appearance as a visual is drawn in it: its variables' values, and the colour scheme the frame must share. */
export type VisualTheme = { variables: Record<string, string>; colorScheme?: string }

// A token's value goes into a stylesheet: one that could close the rule or
// the element it sits in is left out rather than trusted.
const UNSAFE_VALUE = /[<>{};]/u

/** The current appearance, read from the document root's computed tokens. */
export function readVisualTheme(): VisualTheme {
  const style = getComputedStyle(document.documentElement)
  const variables: Record<string, string> = {}
  for (const [name, token] of Object.entries(VISUAL_VARIABLES)) {
    const value = style.getPropertyValue(token).trim()
    if (value && !UNSAFE_VALUE.test(value)) variables[name] = value
  }
  // A frame whose scheme differs from its embedder's is painted opaque, so it
  // takes the window's, whatever that is.
  const scheme = style.getPropertyValue('color-scheme').trim()
  return { variables, ...(scheme && scheme !== 'normal' && !UNSAFE_VALUE.test(scheme) ? { colorScheme: scheme } : {}) }
}

// Sizes the agent instructions assume; the token values replace them.
const FALLBACKS =
  '--font: system-ui, sans-serif; --font-size: 13px; --font-size-small: 12px; --font-size-heading: 14px;'

export function baseStylesheet(theme: VisualTheme): string {
  const variables = Object.entries(theme.variables)
    .filter(([, value]) => !UNSAFE_VALUE.test(value))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ')
  return [
    `:root { ${FALLBACKS} ${variables}${theme.colorScheme ? ` color-scheme: ${theme.colorScheme};` : ''} }`,
    // Part of the reply, not a page in it: no background or margin of its own.
    // `flow-root` keeps a first heading's margin inside the body, which is
    // what the frame measures.
    'html, body { margin: 0; padding: 0; background: transparent; }',
    'body { display: flow-root; font-family: var(--font); font-size: var(--font-size); line-height: 1.45; color: var(--fg); overflow-wrap: break-word; }',
    'svg, img { max-width: 100%; }',
    // SVG text and shapes otherwise paint black, unreadable in dark mode; a
    // `fill` the visual sets on an element still wins over one inherited, and
    // a drawing that sets its own (`fill="none"`, for strokes) keeps it.
    'svg:not([fill]) { fill: currentColor; }',
    'img { height: auto; }',
    'h1, h2, h3, h4 { margin: 0 0 4px; font-size: var(--font-size-heading); font-weight: 600; color: var(--fg-strong, var(--fg)); }',
    'p { margin: 0 0 8px; }',
    'table { border-collapse: collapse; font-variant-numeric: tabular-nums; }',
    'th, td { padding: 4px 12px 4px 0; text-align: left; border-bottom: 1px solid var(--border-subtle, var(--border)); }',
    'th { font-weight: 600; color: var(--fg-muted); }',
    'a { color: inherit; text-decoration: none; cursor: default; }',
  ].join('\n')
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
