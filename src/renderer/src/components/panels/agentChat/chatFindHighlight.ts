// Find in chat, on the page: the ranges a find's matches cover in the rows the
// transcript has drawn, and the highlights that paint them.
//
// Painted with the CSS Custom Highlight API: a range is registered, the
// `::highlight()` rules in assets/index.css colour it, and the DOM is never
// touched. The rows are React's, and a reply still streaming is re-rendered on
// every token, so anything spliced into them would be gone a frame later. A
// window without the API (jsdom, an old engine) finds and counts the same and
// paints nothing.

import { createFindFolder, occurrences } from './chatFind'
import { CHAT_FIND_SEGMENT_ATTRIBUTE } from './chatFindSegment'

export const CHAT_FIND_HIGHLIGHT = 'chat-find'
export const CHAT_FIND_CURRENT_HIGHLIGHT = 'chat-find-current'

// Elements the page draws as a break between words. A <br> or the edge of a
// paragraph has no text of its own, and without a space here "end of one
// line" and "start of the next" would read as one word.
const BREAKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
])

// What a segment holds that is not its text: a code block's header and fold
// control, a table's copy menu (`data-copy-exclude`, the same line a copied
// selection draws), a formula's MathML twin, and anything the page hides from
// assistive tech as decoration.
function skipped(element: Element): boolean {
  return (
    element.hasAttribute('data-copy-exclude') ||
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    element.classList.contains('katex-mathml') ||
    element.tagName === 'SCRIPT' ||
    element.tagName === 'STYLE'
  )
}

/** Where one character of a segment's text was drawn: its text node and offset. */
export type TextPosition = { node: Text; offset: number }

function readText(node: Node, folder: ReturnType<typeof createFindFolder<TextPosition>>) {
  if (node.nodeType === 3) {
    const text = node as Text
    const data = text.data
    for (let offset = 0; offset < data.length; offset++) folder.push(data[offset]!, { node: text, offset })
    return
  }
  if (node.nodeType !== 1) return
  const element = node as Element
  if (skipped(element)) return
  const breaks = BREAKS.has(element.tagName)
  if (breaks) folder.separate()
  for (let child = element.firstChild; child; child = child.nextSibling) readText(child, folder)
  if (breaks) folder.separate()
}

/**
 * The ranges `query` (already folded) covers across one segment's elements,
 * read in document order as one text. A segment can be drawn as more than one
 * element — a plan card's title and its body — and is searched as the index
 * searched it, whole.
 */
export function segmentRanges(elements: readonly Element[], query: string): Range[] {
  if (!query || elements.length === 0) return []
  const { text, tags } = readSegmentText(elements)
  const document = elements[0]!.ownerDocument
  const ranges: Range[] = []
  for (const at of occurrences(text, query)) {
    let first = at
    let last = at + query.length - 1
    // A match may start or end on a folded space, which has no node of its own.
    while (first <= last && !tags[first]) first++
    while (last >= first && !tags[last]) last--
    const start = tags[first]
    const end = tags[last]
    if (!start || !end) continue
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset + 1)
    ranges.push(range)
  }
  return ranges
}

/**
 * One segment's elements read as a find reads them, in document order: the
 * folded text (case folded, whitespace runs one space) and, for each of its
 * characters, where on the page it was drawn — null for a folded space, which
 * has no node of its own. Quoting reads a reply the same way, so a passage it
 * keeps is found again by the same rules (quoteAnchors.ts).
 */
export function readSegmentText(elements: readonly Element[]): { text: string; tags: (TextPosition | null)[] } {
  const folder = createFindFolder<TextPosition>()
  for (const element of elements) {
    folder.separate()
    readText(element, folder)
  }
  return folder.result()
}

/** The segments a transcript has drawn right now, each with its elements in document order. */
export function renderedSegments(root: ParentNode): Map<string, Element[]> {
  const segments = new Map<string, Element[]>()
  for (const element of root.querySelectorAll(`[${CHAT_FIND_SEGMENT_ATTRIBUTE}]`)) {
    const key = element.getAttribute(CHAT_FIND_SEGMENT_ATTRIBUTE)
    if (!key) continue
    const list = segments.get(key)
    if (list) list.push(element)
    else segments.set(key, [element])
  }
  return segments
}

// ── The highlight registry ────────────────────────────────────────────────

// `CSS.highlights` is one registry per document, and more than one chat can
// have its find open at once (two chats side by side). Each find owns its
// ranges here, and the registry's two entries are rebuilt from all of them.
type Painted = { matches: readonly Range[]; current: Range | null }
const painted = new Map<object, Painted>()

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): void }
type HighlightConstructor = new (...ranges: Range[]) => { priority: number }

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null
}

function repaint() {
  const api = highlightApi()
  if (!api) return
  const matches: Range[] = []
  const current: Range[] = []
  for (const entry of painted.values()) {
    matches.push(...entry.matches)
    if (entry.current) current.push(entry.current)
  }
  if (matches.length) api.registry.set(CHAT_FIND_HIGHLIGHT, new api.Highlight(...matches))
  else api.registry.delete(CHAT_FIND_HIGHLIGHT)
  if (current.length) {
    const highlight = new api.Highlight(...current)
    // Over the plain match it also is, whichever was registered first.
    highlight.priority = 1
    api.registry.set(CHAT_FIND_CURRENT_HIGHLIGHT, highlight)
  } else api.registry.delete(CHAT_FIND_CURRENT_HIGHLIGHT)
}

/** Paint one find's matches, replacing what it painted before. */
export function paintChatFind(owner: object, matches: readonly Range[], current: Range | null): void {
  if (matches.length === 0 && !current) {
    clearChatFind(owner)
    return
  }
  painted.set(owner, { matches, current })
  repaint()
}

/** Take one find's highlights off the page. */
export function clearChatFind(owner: object): void {
  if (!painted.delete(owner)) return
  repaint()
}
