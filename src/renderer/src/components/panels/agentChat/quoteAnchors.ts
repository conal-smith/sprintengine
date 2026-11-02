// Where a quoted passage is in a reply on the page, in both directions: the
// passage a selection makes (what the quote keeps to find it again), and the
// range a kept passage covers now (what the highlight paints).
//
// A reply is read the way Find in chat reads it (`readSegmentText`): its text
// nodes in order, chrome left out, every run of whitespace one space. The page
// is React's and a reply re-renders while it streams, so nothing here holds a
// node for longer than one paint: a quote keeps words and their surroundings,
// and the range is worked out again from them whenever the rows change.

import { QUOTE_CONTEXT_CHARS, locateQuote, type ChatQuote } from '../../../../../shared/chat-quotes'
import { readSegmentText, type TextPosition } from './chatFindHighlight'

/** The attribute on each element of a reply whose prose a quote may cite, naming its turn. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-quote-source'

/** What a selection in one reply cites: everything a quote keeps but its number and comment. */
export type QuoteCitation = Pick<ChatQuote, 'turnId' | 'exact' | 'prefix' | 'suffix'>

type SourceText = { text: string; tags: (TextPosition | null)[] }

// The text as drawn, case kept: each folded character's own character, and a
// space where the reader folded whitespace or a block edge.
function drawnText(elements: readonly Element[]): SourceText {
  const { tags } = readSegmentText(elements)
  return { text: tags.map((tag) => (tag ? tag.node.data[tag.offset]! : ' ')).join(''), tags }
}

function ancestorElement(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/** The reply prose `node` sits in, when it sits in one. */
export function quoteSourceOf(node: Node | null): Element | null {
  const element = node ? ancestorElement(node) : null
  return element?.closest(`[${QUOTE_SOURCE_ATTRIBUTE}]`) ?? null
}

/**
 * What `range` cites, when it lies wholly inside one stretch of a reply's
 * prose: the turn, the passage as drawn, and the drawn text either side of it.
 * Null for a selection that starts or ends anywhere else — a message of the
 * person's own, a run over several messages, a step's output — or that holds
 * no drawn text.
 */
export function citationForRange(range: Range): QuoteCitation | null {
  const source = quoteSourceOf(range.commonAncestorContainer)
  const turnId = source?.getAttribute(QUOTE_SOURCE_ATTRIBUTE)
  if (!source || !turnId) return null
  const { text, tags } = drawnText([source])
  // A character is selected when both its edges are inside the range.
  const inside = (tag: TextPosition) =>
    range.comparePoint(tag.node, tag.offset) === 0 && range.comparePoint(tag.node, tag.offset + 1) === 0
  let start = -1
  let end = -1
  tags.forEach((tag, index) => {
    if (!tag || !inside(tag)) return
    if (start < 0) start = index
    end = index + 1
  })
  if (start < 0) return null
  return {
    turnId,
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start).trim(),
    suffix: text.slice(end, end + QUOTE_CONTEXT_CHARS).trim(),
  }
}

/** The drawn prose of each turn under `root`, keyed by turn id, in document order. */
export function quoteSources(root: ParentNode): Map<string, Element[]> {
  const sources = new Map<string, Element[]>()
  for (const element of root.querySelectorAll(`[${QUOTE_SOURCE_ATTRIBUTE}]`)) {
    const turnId = element.getAttribute(QUOTE_SOURCE_ATTRIBUTE)
    if (!turnId) continue
    const list = sources.get(turnId)
    if (list) list.push(element)
    else sources.set(turnId, [element])
  }
  return sources
}

/**
 * The range a quote's passage covers in its turn's drawn prose, or null when
 * the passage is not there — the reply was edited away, or the passage was
 * drawn differently than when it was quoted. Nothing else depends on finding
 * it: the chip and its popover read the quote itself.
 */
export function rangeForQuote(elements: readonly Element[], quote: Pick<ChatQuote, 'exact' | 'prefix' | 'suffix'>) {
  if (!elements.length) return null
  const { text, tags } = drawnText(elements)
  const found = locateQuote(text, quote)
  if (!found) return null
  let first = found.start
  let last = found.end - 1
  while (first <= last && !tags[first]) first++
  while (last >= first && !tags[last]) last--
  const start = tags[first]
  const end = tags[last]
  if (!start || !end) return null
  const range = elements[0]!.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
}
