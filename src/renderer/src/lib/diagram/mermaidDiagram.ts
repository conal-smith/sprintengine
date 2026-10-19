// Mermaid diagrams drawn from a reply's ```mermaid fences.
//
// The renderer is large and almost no conversation needs it, so it is loaded
// the first time a diagram is drawn, never with the app. Its configuration is
// global — `initialize` replaces it for every diagram after — so diagrams are
// drawn one at a time, each with the configuration it was asked for. A
// diagram's SVG is kept per appearance and source, so a settled message that
// re-renders, or scrolls back into view, does not draw it again.
//
// The source is an agent's text, and a diagram must not run anything, link
// anywhere or load anything from outside the reply: a fetched image or
// stylesheet tells whoever serves it that the reply was read, and when. Mermaid
// adds the SVG to the page to measure its labels before handing it back, so
// sanitizing what comes back cannot stop a load that has already started.
// Four layers, then: a source that names an image or stylesheet to load is
// not drawn at all — read as text first (`loadsFromElsewhere`), then as the
// diagram Mermaid parsed it into (`parsedDiagramLoads`), since the text can
// spell an image in more ways than a pattern can follow; the drawing runs at
// `securityLevel: 'strict'` with labels as SVG text and a diagram's own
// configuration kept off every setting that reaches the page unsanitized
// (`SECURE_KEYS`), and while it runs no image it adds is let point outside
// the page (`withoutRemoteImages`); and the SVG that comes back is sanitized
// once more before the page keeps it (`sanitizeDiagramSvg`).

type Mermaid = typeof import('mermaid').default
type Purify = typeof import('dompurify').default
type Engine = { mermaid: Mermaid; purify: Purify }

let engine: Promise<Engine> | null = null

// A failed load is forgotten, so the next diagram, or a Retry, asks again.
function loadEngine(): Promise<Engine> {
  engine ??= Promise.all([import('mermaid'), import('dompurify')]).then(
    ([mermaid, purify]) => ({ mermaid: mermaid.default, purify: purify.default }),
    (error: unknown) => {
      engine = null
      throw error
    },
  )
  return engine
}

/**
 * A drawing, or why there is none. `retry` marks a failure that was the
 * network's, not the diagram's — the renderer, or a part of it, did not load —
 * so asking again may draw it.
 */
export type DiagramResult = { svg: string } | { error: string; retry?: boolean }

// ---- Nothing from outside the diagram -----------------------------------------

// Elements and attributes that load, link or run, whatever a label holds.
const LOADING_TAGS = ['a', 'img', 'image', 'script']
const LOADING_ATTRIBUTES = ['href', 'xlink:href', 'src', 'srcset']

// CSS that fetches: a `url()` to anything but an element of the diagram itself
// (`url(#arrowhead)`, which markers and gradients use), `image-set()`, which
// takes bare strings as URLs, and `@import`.
const REMOTE_CSS = /\burl\s*\(\s*(?!['"]?\s*#)[^)]*\)?|(?:-webkit-)?image-set\s*\([^)]*\)?|@import\b[^;]*;?/giu

// CSS reads `\75 rl(` and `u\rl(` as `url(`, so CSS is judged with its
// escapes decoded.
function decodeCssEscapes(text: string): string {
  if (!text.includes('\\')) return text
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(.))/gisu, (_match, hex: string | undefined, char: string) => {
    if (!hex) return char
    const point = parseInt(hex, 16)
    return point && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
  })
}

function hasRemoteCss(text: string): boolean {
  REMOTE_CSS.lastIndex = 0
  return REMOTE_CSS.test(text)
}

/** CSS, or a value in an attribute, with every fetch in it made inert. */
function withoutRemoteCss(css: string): string {
  const decoded = decodeCssEscapes(css)
  if (!hasRemoteCss(decoded)) return css
  return decoded.replace(REMOTE_CSS, (found) => (found.startsWith('@') ? '' : 'none'))
}

// Mermaid reads `#117;` as the character 117 and `#quot;` as the entity of
// that name, and a label or style it writes as markup reads `&#117;`,
// `&#x75;` and `&quot;` the same way, so a source is judged with its
// entities decoded too. Twice over, for an entity spelled with one.
const ENTITY = /[&#](?:#?x[0-9a-f]+|#?\d+|[a-z][a-z0-9]*);/giu
let entityReader: HTMLTextAreaElement | null = null

function decodeEntities(text: string): string {
  let decoded = text
  for (let pass = 0; pass < 3; pass++) {
    ENTITY.lastIndex = 0
    if (!ENTITY.test(decoded)) break
    const next = decoded.replace(ENTITY, (entity) => {
      // Mermaid's spelling, `#…;`, is the HTML one without its `&`.
      const html = !entity.startsWith('#') ? entity : /^#\d+;$/u.test(entity) ? `&${entity}` : `&${entity.slice(1)}`
      const numeric = /^&#(x?)([0-9a-f]+);$/iu.exec(html)
      if (numeric) {
        const point = parseInt(numeric[2]!, numeric[1] ? 16 : 10)
        return point && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
      }
      if (typeof document === 'undefined') return entity
      entityReader ??= document.createElement('textarea')
      entityReader.innerHTML = html
      return entityReader.value
    })
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

// What makes Mermaid itself fetch while it lays a diagram out: CSS in a
// `style`, `classDef` or init directive, a node's `img` (which it loads to
// measure), and a sequence participant's icon given as an address rather than
// an `@`-named symbol of the diagram's own. Only a cheap first look: shape
// data is YAML, which quotes and escapes a key any number of ways, so what the
// diagram was parsed into is read as well (`parsedDiagramLoads`).
const LOADING_SYNTAX = [/@\{[^}]*\bimg\s*:/u, /["']icon["']\s*:\s*["']\s*(?!@)/u]

/** Whether drawing this source would load something from outside it, judged from its text. */
export function loadsFromElsewhere(source: string): boolean {
  const decoded = decodeEntities(source)
  return (
    hasRemoteCss(decodeCssEscapes(source)) ||
    hasRemoteCss(decodeCssEscapes(decoded)) ||
    LOADING_SYNTAX.some((pattern) => pattern.test(source) || pattern.test(decoded))
  )
}

type ParsedModel = {
  getVertices?: () => Map<string, { img?: unknown }> | Record<string, { img?: unknown }>
  getData?: () => { nodes?: Array<{ img?: unknown }> }
  getActors?: () => Map<string, { properties?: { icon?: unknown } }>
}

function valuesOf<T>(collection: Map<string, T> | Record<string, T> | undefined | null): T[] {
  if (!collection) return []
  return collection instanceof Map ? [...collection.values()] : Object.values(collection)
}

/**
 * Whether the diagram Mermaid parsed would load something while it is drawn:
 * a node with an image (a flowchart's image shape, and any diagram whose
 * layout data carries one), or a participant whose icon is an address rather
 * than an `@`-named symbol of the diagram's own. Read from the parsed model,
 * so it does not matter how the source spelled the key. A model that cannot
 * be read is taken to load.
 */
export function parsedDiagramLoads(diagram: { db: unknown }): boolean {
  const db = (diagram.db ?? {}) as ParsedModel
  try {
    const nodes = [...valuesOf(db.getVertices?.()), ...(db.getData?.().nodes ?? [])]
    if (nodes.some((node) => node?.img != null && node.img !== '')) return true
    return valuesOf(db.getActors?.()).some((actor) => {
      const icon = actor?.properties?.icon
      return icon != null && !String(icon).trim().startsWith('@')
    })
  } catch {
    return true
  }
}

export const LOADS_FROM_ELSEWHERE = 'Diagrams in a reply do not load images or styles from elsewhere'

// ---- No image leaves the page while a diagram is drawn -------------------------

// An address that stays on the page: a fragment of the diagram's own, an
// image carried inline, or nothing.
const ON_PAGE = /^\s*(?:#|data:|blob:|$)/iu
const IMAGE_ATTRIBUTES = new Set(['src', 'srcset', 'href'])

class RemoteImageRefused extends Error {
  constructor() {
    super(LOADS_FROM_ELSEWHERE)
  }
}

/**
 * Runs `draw` with every image it starts refused unless its address stays on
 * the page — the backstop for an image the two readings of the source missed.
 * A content security policy cannot be the backstop: the window shows remote
 * images on purpose (pictures in replies, avatars, favicons, extension icons),
 * and a policy, or a request filter in the main process, sees a request with
 * no way to tell which element asked for it. So the guard is here, and only
 * for as long as the drawing runs, which is one diagram at a time.
 *
 * What it covers is what Mermaid does: an `Image` whose `src` it sets as a
 * property to measure the picture before the node is placed, and an
 * `<image>`'s `href` it sets as an attribute inside the scratch element it
 * draws in. Only images the drawing could have made are judged: one inside
 * the scratch element, or one off the page that was made while the drawing
 * ran (by `new Image()` or the document's `createElement`). The page's own
 * images are out of its reach — an `<img>` React draws, which is on the page
 * and outside that element, and any image made before the drawing began, an
 * avatar's preload kept for reuse, say. An image the page itself makes off
 * the page while a diagram draws is the one it cannot tell from Mermaid's;
 * those the window makes then (an attachment's preview) have a `data:` or
 * `blob:` address. A refused image fails the drawing, and the block says why.
 */
export async function withoutRemoteImages<T>(scratchId: string, draw: () => Promise<T>): Promise<T> {
  if (typeof HTMLImageElement === 'undefined' || typeof Element === 'undefined') return draw()
  const image = HTMLImageElement.prototype
  const element = Element.prototype
  const reflected = (['src', 'srcset'] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(image, name)] as const,
  )
  const { setAttribute, setAttributeNS } = element
  let refused = false

  // The images made while the drawing runs, so an image off the page is
  // judged only when the drawing could have made it.
  const madeDuringDraw = new WeakSet<Element>()
  const ownImage = Object.getOwnPropertyDescriptor(window, 'Image')
  const PageImage = window.Image
  const TrackedImage = function Image(width?: number, height?: number) {
    const made = new PageImage(width, height)
    madeDuringDraw.add(made)
    return made
  } as unknown as typeof Image
  TrackedImage.prototype = PageImage.prototype
  window.Image = TrackedImage
  const ownCreateElement = Object.getOwnPropertyDescriptor(document, 'createElement')
  const ownCreateElementNS = Object.getOwnPropertyDescriptor(document, 'createElementNS')
  const { createElement, createElementNS } = document
  document.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
    const made = createElement.apply(this, args)
    madeDuringDraw.add(made)
    return made
  } as Document['createElement']
  document.createElementNS = function (this: Document, ...args: [string | null, string]) {
    const made = createElementNS.apply(this, args)
    madeDuringDraw.add(made)
    return made
  } as Document['createElementNS']

  const inScratch = (node: Element) => node.closest(`#${CSS.escape(scratchId)}`) !== null
  // Off the page, only what the drawing made counts as the drawing's.
  const drawnOffPage = (node: Element) => !node.isConnected && madeDuringDraw.has(node)
  const inDiagram = (node: Element) =>
    inScratch(node) || (drawnOffPage(node) && typeof SVGImageElement !== 'undefined' && node instanceof SVGImageElement)
  const refuse = (): never => {
    refused = true
    throw new RemoteImageRefused()
  }

  for (const [name, descriptor] of reflected) {
    if (!descriptor?.set) continue
    const set = descriptor.set
    Object.defineProperty(image, name, {
      ...descriptor,
      set(this: HTMLImageElement, value: unknown) {
        if (!ON_PAGE.test(String(value)) && (drawnOffPage(this) || inScratch(this))) refuse()
        set.call(this, value)
      },
    })
  }
  element.setAttribute = function (this: Element, name: string, value: string) {
    if (
      IMAGE_ATTRIBUTES.has(name.toLowerCase().replace(/^xlink:/u, '')) &&
      !ON_PAGE.test(String(value)) &&
      inDiagram(this)
    )
      refuse()
    setAttribute.call(this, name, value)
  }
  element.setAttributeNS = function (this: Element, namespace: string | null, name: string, value: string) {
    const local = name.slice(name.indexOf(':') + 1).toLowerCase()
    if (IMAGE_ATTRIBUTES.has(local) && !ON_PAGE.test(String(value)) && inDiagram(this)) refuse()
    setAttributeNS.call(this, namespace, name, value)
  }

  try {
    const result = await draw()
    if (refused) throw new RemoteImageRefused()
    return result
  } catch (error) {
    // Mermaid catches some failures itself; a refusal is reported as one
    // whatever became of the error it threw.
    throw refused ? new RemoteImageRefused() : error
  } finally {
    for (const [name, descriptor] of reflected) if (descriptor) Object.defineProperty(image, name, descriptor)
    element.setAttribute = setAttribute
    element.setAttributeNS = setAttributeNS
    // Put back as they were: the document's own methods come from its
    // prototype, so an own property added here is taken away again.
    restoreOwn(window, 'Image', ownImage, PageImage)
    restoreOwn(document, 'createElement', ownCreateElement, createElement)
    restoreOwn(document, 'createElementNS', ownCreateElementNS, createElementNS)
  }
}

function restoreOwn(target: object, key: string, own: PropertyDescriptor | undefined, value: unknown): void {
  // An accessor took the stand-in through its setter, and takes the original back the same way.
  if (own?.set) (target as Record<string, unknown>)[key] = value
  else if (own) Object.defineProperty(target, key, own)
  else {
    Reflect.deleteProperty(target, key)
    // Not inherited after all (a stand-in global): set it back as it was read.
    if ((target as Record<string, unknown>)[key] !== value) (target as Record<string, unknown>)[key] = value
  }
}

// Settings a diagram's `%%{init}%%` or front matter may not change. Mermaid's
// own list first: `secure` replaces it rather than adding to it.
const SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  // HTML labels are added to the page to be measured, unsanitized by us.
  'htmlLabels',
  // Each is written into the diagram's <style>, which is on the page while it
  // is measured: CSS of the diagram's own, and fonts and colours (a directive's
  // font is copied into the theme's variables, so those are kept too).
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
  // How Mermaid sanitizes label text, which is set below, and markers drawn
  // as absolute URLs.
  'dompurifyConfig',
  'arrowMarkerAbsolute',
]

let svgPurifier: ReturnType<Purify> | null = null

// Mermaid typesets a `$$…$$` label with KaTeX, whose output there is MathML:
// with no MathML allowed the sanitizer emptied every math label to a bare
// `<span class="katex">`. These are the elements KaTeX writes, less three:
// `annotation` (Mermaid drops it), `semantics` (only a wrapper; what it wraps
// is kept) and `mglyph` (an image). `maction` and `annotation-xml` are never
// allowed. DOMPurify still takes `<math>` only under an HTML parent (a label's
// `<div>` in a `foreignObject`) and checks each child's namespace.
const KATEX_MATHML_TAGS = new Set([
  'math',
  'menclose',
  'mfrac',
  'mi',
  'mlabeledtr',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mroot',
  'mrow',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
])
// The presentation attributes KaTeX sets on them, on them only. The profiles
// above already allow class, style, width, height, display and xmlns.
const KATEX_MATHML_ATTRIBUTES = new Set([
  'accent',
  'accentunder',
  'columnalign',
  'columnlines',
  'columnspacing',
  'depth',
  'displaystyle',
  'fence',
  'largeop',
  'linebreak',
  'linethickness',
  'lspace',
  'mathbackground',
  'mathcolor',
  'mathsize',
  'mathvariant',
  'maxsize',
  'minsize',
  'notation',
  'rowlines',
  'rowspacing',
  'rspace',
  'scriptlevel',
  'separator',
  'stretchy',
  'voffset',
])

// A sanitizer of our own rather than the shared one, which Mermaid also uses
// and configures with hooks of its own.
function purifier(purify: Purify): ReturnType<Purify> {
  if (svgPurifier) return svgPurifier
  const instance = purify(window)
  instance.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = withoutRemoteCss(node.textContent)
  })
  // Any attribute, not only `style`: SVG paints with `fill="url(…)"`, `filter`,
  // `mask` and `clip-path` as well.
  instance.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrValue) data.attrValue = withoutRemoteCss(data.attrValue)
  })
  svgPurifier = instance
  return instance
}

/**
 * The SVG as the page may hold it: SVG, and the HTML Mermaid sets inside a
 * `foreignObject` for the labels a few diagrams draw that way (Venn sets,
 * architecture icons, typeset math as KaTeX's MathML), with every script, handler, link, image
 * and CSS fetch taken out. `url(#id)`, the diagram pointing at its own markers
 * and gradients, stays.
 */
export function sanitizeDiagramSvg(purify: Purify, svg: string): string {
  return purifier(purify).sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', ...KATEX_MATHML_TAGS],
    ADD_ATTR: (attribute, tagName) => KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: LOADING_TAGS,
    FORBID_ATTR: LOADING_ATTRIBUTES,
  })
}

// ---- The appearance a diagram is drawn in ----------------------------------

/**
 * Which appearance the window is in: the theme and its light or dark mode, as
 * the document root carries them. A diagram is drawn per appearance, since its
 * colours are baked into the SVG.
 */
export function appearanceKey(): string {
  if (typeof document === 'undefined') return ''
  const root = document.documentElement
  return `${root.getAttribute('data-theme') ?? ''}|${root.getAttribute('data-mode') ?? ''}`
}

// One observer for every diagram on screen, there only while one is.
const appearanceListeners = new Set<() => void>()
let appearanceObserver: MutationObserver | null = null

/** Calls `onChange` when the window's appearance changes; returns the unsubscribe. */
export function subscribeAppearance(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  appearanceListeners.add(onChange)
  if (!appearanceObserver) {
    appearanceObserver = new MutationObserver(() => {
      for (const listener of appearanceListeners) listener()
    })
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode'],
    })
  }
  return () => {
    appearanceListeners.delete(onChange)
    if (appearanceListeners.size || !appearanceObserver) return
    appearanceObserver.disconnect()
    appearanceObserver = null
  }
}

// Mermaid's `base` theme derives every colour it is not given from the ones it
// is, so these are the roles a diagram draws with, each from the semantic token
// with that meaning: a node is a raised fill on the block's surface, its line
// and label take the border and body ink, edges the quieter ink.
const THEME_TOKENS: Record<string, string> = {
  background: '--sem-color-bg-surface',
  mainBkg: '--sem-color-bg-active',
  primaryColor: '--sem-color-bg-active',
  primaryBorderColor: '--sem-color-border-strong',
  primaryTextColor: '--sem-color-text-default',
  nodeBorder: '--sem-color-border-strong',
  nodeTextColor: '--sem-color-text-default',
  textColor: '--sem-color-text-default',
  titleColor: '--sem-color-text-primary',
  lineColor: '--sem-color-text-muted',
  secondaryColor: '--sem-color-accent-soft',
  tertiaryColor: '--sem-color-bg-hover',
  clusterBkg: '--sem-color-bg-well',
  clusterBorder: '--sem-color-border-default',
  edgeLabelBackground: '--sem-color-bg-surface',
  noteBkgColor: '--sem-color-status-warn-soft',
  noteBorderColor: '--sem-color-border-default',
  noteTextColor: '--sem-color-text-default',
  actorBkg: '--sem-color-bg-active',
  actorBorder: '--sem-color-border-strong',
  actorTextColor: '--sem-color-text-default',
  signalColor: '--sem-color-text-muted',
  signalTextColor: '--sem-color-text-default',
  labelBoxBkgColor: '--sem-color-bg-active',
  labelBoxBorderColor: '--sem-color-border-strong',
  labelTextColor: '--sem-color-text-default',
  loopTextColor: '--sem-color-text-default',
  activationBkgColor: '--sem-color-bg-hover',
  activationBorderColor: '--sem-color-border-strong',
  sequenceNumberColor: '--sem-color-text-on-accent',
  errorBkgColor: '--sem-color-status-danger-soft',
  errorTextColor: '--sem-color-status-danger',
}

// Mermaid computes shades from the colours it is handed, so each has to be
// one its colour library reads: a token written any other way (a mix, a wide
// gamut) is painted once and read back as rgba.
const LEGIBLE_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]*\))$/iu

function colorReader(): (value: string) => string | undefined {
  let probe: CanvasRenderingContext2D | null | undefined
  return (value) => {
    if (!value || LEGIBLE_COLOR.test(value)) return value || undefined
    if (probe === undefined) {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      probe = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (!probe) return undefined
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = 'rgba(0, 0, 0, 0)'
    probe.fillStyle = value
    probe.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data
    return alpha ? `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})` : undefined
  }
}

function themeVariables(): Record<string, string | boolean> {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const read = (token: string) => style.getPropertyValue(token).trim()
  const color = colorReader()
  const variables: Record<string, string | boolean> = { darkMode: root.getAttribute('data-mode') === 'dark' }
  for (const [name, token] of Object.entries(THEME_TOKENS)) {
    const value = color(read(token))
    if (value) variables[name] = value
  }
  const font = read('--sem-font-family-ui')
  const size = read('--sem-font-size-body')
  if (font) variables.fontFamily = font
  if (size) variables.fontSize = size
  return variables
}

// ---- One drawing, many copies ------------------------------------------------

/**
 * The drawing with every id it declares moved under `scope`, and every
 * reference to one of them with it: a `url(#…)` (the arrowheads, markers and
 * gradients), an `aria-labelledby` or `aria-describedby`, and a `#…` selector
 * in its own stylesheet. A drawing is kept once and shown wherever its source
 * is (the same diagram in two replies, a reply and its search result), and
 * copies sharing ids share the first copy's markers: hide that one and every
 * other copy's arrowheads go with it.
 */
export function scopeDiagramIds(svg: string, scope: string): string {
  const ids = new Set<string>()
  for (const match of svg.matchAll(/\sid="([^"]+)"/gu)) ids.add(match[1])
  if (!ids.size) return svg
  const scoped = (id: string) => (ids.has(id) ? `${scope}-${id}` : id)
  return svg
    .replace(/(\sid=")([^"]+)"/gu, (_, open: string, id: string) => `${open}${scoped(id)}"`)
    .replace(/(url\(\s*(?:['"]|&quot;)?#)([^)'"&\s]+)/gu, (_, open: string, id: string) => open + scoped(id))
    .replace(
      /(\saria-(?:labelledby|describedby)=")([^"]*)"/gu,
      (_, open: string, list: string) => `${open}${list.split(/\s+/u).map(scoped).join(' ')}"`,
    )
    .replace(
      /(<style[^>]*>)([\s\S]*?)(<\/style>)/gu,
      (_, open: string, css: string, close: string) =>
        open + css.replace(/#([\w-]+)/gu, (whole, id: string) => (ids.has(id) ? `#${scoped(id)}` : whole)) + close,
    )
}

// ---- Drawing, one at a time --------------------------------------------------

// Bounded, least recently used out: an SVG is tens of kilobytes, and a window
// stays open for days of transcripts.
const MAX_CACHED = 32
const cache = new Map<string, DiagramResult>()
const drawing = new Map<string, Promise<DiagramResult>>()
let queue: Promise<unknown> = Promise.resolve()
let serial = 0

function cacheKey(appearance: string, source: string): string {
  return `${appearance}\0${source}`
}

/** The diagram already drawn for this appearance and source, if there is one. */
export function cachedDiagram(appearance: string, source: string): DiagramResult | undefined {
  const key = cacheKey(appearance, source)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function remember(key: string, result: DiagramResult): void {
  cache.set(key, result)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
}

/**
 * Draws a diagram, after every diagram asked for before it. The same source
 * asked for twice while it is being drawn is drawn once. A source that does
 * not parse resolves to its error — never a rejection — and that answer is
 * kept like a drawing is; a renderer that failed to load is not, so the next
 * diagram, or a Retry, asks for it again.
 */
export function drawDiagram(appearance: string, source: string): Promise<DiagramResult> {
  const key = cacheKey(appearance, source)
  const hit = cachedDiagram(appearance, source)
  if (hit) return Promise.resolve(hit)
  const pending = drawing.get(key)
  if (pending) return pending
  const run = queue.then(async (): Promise<DiagramResult> => {
    if (loadsFromElsewhere(source)) {
      const refused = { error: LOADS_FROM_ELSEWHERE }
      remember(key, refused)
      return refused
    }
    const loaded = await loadEngine().catch(() => null)
    if (!loaded) return { error: 'The diagram renderer could not be loaded', retry: true }
    const result = await render(loaded, source)
    if (!('retry' in result)) remember(key, result)
    return result
  })
  queue = run.catch(() => undefined)
  drawing.set(key, run)
  void run.finally(() => drawing.delete(key)).catch(() => undefined)
  return run
}

const CHUNK_LOAD_FAILED = /dynamically imported module|importing a module script|failed to fetch/iu

async function render({ mermaid, purify }: Engine, source: string): Promise<DiagramResult> {
  const id = `chat-diagram-${++serial}`
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: SECURE_KEYS,
      // Labels as SVG text, which is never parsed as markup. The flowchart's
      // own switch is the older spelling of the same setting, and some
      // diagrams still read it.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // What Mermaid's own sanitizer keeps in the label text it still sets as
      // markup — before the page is out of reach of anything that loads.
      // A `style` attribute is CSS, and CSS can fetch.
      dompurifyConfig: { FORBID_TAGS: ['style', ...LOADING_TAGS], FORBID_ATTR: ['style', ...LOADING_ATTRIBUTES] },
      theme: 'base',
      themeVariables: themeVariables(),
      // A diagram that does not parse is reported to the block, which shows
      // its source instead; Mermaid must not draw its own error graphic.
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
    })
    // Parse first: a syntax error then throws here, before anything is added
    // to the document to measure. `parse` applies the diagram's directives as
    // `render` will; the diagram it parses to is then read for what it would
    // load, however its source spelled it.
    await mermaid.parse(source)
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source)
    if (parsedDiagramLoads(parsed)) return { error: LOADS_FROM_ELSEWHERE }
    const { svg } = await withoutRemoteImages(`d${id}`, () => mermaid.render(id, source))
    return { svg: sanitizeDiagramSvg(purify, svg) }
  } catch (error) {
    if (error instanceof RemoteImageRefused) return { error: LOADS_FROM_ELSEWHERE }
    const message = error instanceof Error ? error.message : String(error)
    // Mermaid loads each kind of diagram's code as it is first drawn; that
    // failing is the network's doing, not the diagram's.
    return CHUNK_LOAD_FAILED.test(message) ? { error: message, retry: true } : { error: message }
  } finally {
    // The scratch element Mermaid measures in, should a failure leave it behind.
    document.getElementById(`d${id}`)?.remove()
  }
}
