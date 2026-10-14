export type MarkdownSegments = { frozen: string[]; tail: string }

const BLOCK_HTML = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'details',
  'div',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'pre',
  'script',
  'section',
  'style',
  'table',
  'textarea',
  'ul',
  'ol',
])

// A definition anywhere changes how text everywhere reads: a link reference
// (`[id]: /url`) turns `[text][id]` above it into a link, and a footnote
// (`[^1]: …`) turns `[^1]` into a reference and adds a section at the end. A
// message holding one is parsed whole.
const DEFINITION = /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:/u
// Parsed differently, or not at all, when split: a carriage return or a byte
// order mark shifts what a "line" is.
const UNSPLITTABLE_TEXT = /\r|﻿/u
// HTML blocks that run across blank lines until their own closer: processing
// instructions, declarations and CDATA. Rare in a reply; one keeps the rest of
// the message in the tail.
const LONG_HTML_BLOCK = /<\?|<![A-Za-z[]/u
const BLANK = /^[ \t]*$/u
const FENCE_OPENER = /^( {0,3})(`{3,}|~{3,})(.*)$/u
const FENCE_CLOSER = /^ {0,3}(`+|~+)[ \t]*$/u
// A display math block, read as the chat's math parser reads one
// (renderer/src/utils/markdownMath.tsx): `$$` alone on a line opens and closes
// it; `\[` opens a line and an unescaped `\]` ending a line closes it, the
// opening line included. A `\]` with text after it is a sentence's bracket,
// and the block it was in is no block at all.
const DOLLAR_MATH = /^ {0,3}\$\$[ \t]*$/u
const DOLLAR_MATH_CLOSER = /^[ \t]*\$\$[ \t]*$/u
const BRACKET_MATH_OPENER = /^ {0,3}\\\[/u
const BRACKET_MATH_CLOSER = /(?:^|[^\\])(?:\\\\)*\\\][ \t]*$/u
const BRACKET_MATH_BROKEN = /(?:^|[^\\])(?:\\\\)*\\\](?![ \t]*$)/u
const TAG = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu
// How much of a tag cut by a line break is kept while its end streams in.
const MAX_CARRIED_TAG = 1_000

const withoutCodeSpans = (line: string) => line.replace(/(`+)(.*?[^`])\1(?!`)/gu, '')

/**
 * Whether a segment may end before a line that follows a blank line, from as
 * much of that line as has streamed. Only a line that starts at the margin
 * with something other than a list marker ends every block before it without
 * changing how that block reads: an indented line may continue a list item or
 * an indented code block, and a marker may continue a list, making it loose.
 */
function boundaryBefore(line: string, complete: boolean): 'split' | 'no' | 'undecided' {
  const first = line[0]
  if (first === undefined) return complete ? 'no' : 'undecided'
  if (first === ' ' || first === '\t') return 'no'
  if (first === '-' || first === '+' || first === '*') {
    const second = line[1]
    if (second === undefined) return complete ? 'no' : 'undecided'
    return second === ' ' || second === '\t' ? 'no' : 'split'
  }
  if (first >= '0' && first <= '9') {
    const marker = /^\d{1,9}(?:[.)]([ \t])?)?/u.exec(line)![0]
    if (/[.)][ \t]$/u.test(marker)) return 'no'
    if (marker.length === line.length) {
      if (complete) return /[.)]$/u.test(marker) ? 'no' : 'split'
      return marker.length <= 10 ? 'undecided' : 'split'
    }
    return 'split'
  }
  return 'split'
}

type Fence = { char: string; width: number; indented: boolean }

/** Whether a `\[` block's line, or what follows its opener, ends it — closed, or broken and so never math. */
const bracketMathEnds = (text: string) => BRACKET_MATH_CLOSER.test(text) || BRACKET_MATH_BROKEN.test(text)

/**
 * Splits a streaming message into segments that can be parsed apart and read
 * exactly as the whole message does, so a new token re-parses only the last
 * one. A segment ends
 *  - after a closed, unindented code fence and the blank line after it, and
 *  - before a line that follows a blank line, outside a fence, when that line
 *    starts at the margin with something other than a list marker (a
 *    paragraph, a heading, a quote, a table, a fence, a rule).
 * Nothing splits inside a display math block, whose TeX may hold blank lines
 * (split there, neither half closes, and both read as text), nor while raw
 * HTML is open (it swallows what follows), and a
 * message holding a definition, a carriage return or a byte order mark is not
 * split at all.
 *
 * The splitter keeps its place: given the text it saw last with more appended
 * — which is how a reply streams — it reads only the new text. Given anything
 * else it starts over. Frozen segments keep their string identity from call to
 * call, so memoized renders of them are reused.
 */
export function createMarkdownSplitter(): (source: string) => MarkdownSegments {
  let seen = ''
  let frozen: string[] = []
  let segmentStart = 0
  let lineStart = 0
  let fence: Fence | null = null
  let math: 'dollar' | 'bracket' | null = null
  let awaitingBlank = false
  let blankBefore = false
  let blocked = false
  let comments = 0
  const stack: string[] = []
  let carry = ''

  const reset = () => {
    seen = ''
    frozen = []
    segmentStart = 0
    lineStart = 0
    fence = null
    math = null
    awaitingBlank = false
    blankBefore = false
    blocked = false
    comments = 0
    stack.length = 0
    carry = ''
  }

  const htmlOpen = () => comments > 0 || stack.length > 0 || carry !== ''

  // Raw HTML in a line of prose. A tag cut by a line break is read once the
  // rest of it arrives.
  const readHtml = (line: string) => {
    if (LONG_HTML_BLOCK.test(line)) blocked = true
    comments += line.match(/<!--/gu)?.length ?? 0
    comments -= line.match(/-->/gu)?.length ?? 0
    const text = carry ? `${carry}\n${line}` : line
    carry = ''
    let consumed = 0
    for (const match of text.matchAll(TAG)) {
      consumed = match.index + match[0].length
      const tag = match[1].toLowerCase()
      if (!BLOCK_HTML.has(tag) || match[0].endsWith('/>')) continue
      if (match[0].startsWith('</')) {
        if (stack.at(-1) === tag) stack.pop()
      } else stack.push(tag)
    }
    // Only a block tag moves the stack, so only one of those is worth waiting
    // for, and not for ever: prose like "a <div without an end" would
    // otherwise hold every later split.
    const open = /<\/?([a-z][a-z0-9-]*)\b[^>]*$/iu.exec(text.slice(consumed))
    if (open && BLOCK_HTML.has(open[1].toLowerCase()) && open[0].length <= MAX_CARRIED_TAG) carry = open[0]
  }

  const freezeAt = (position: number) => {
    if (position <= segmentStart || htmlOpen()) return
    frozen.push(seen.slice(segmentStart, position))
    segmentStart = position
  }

  const scan = (source: string) => {
    const added = source.slice(seen.length)
    seen = source
    if (blocked) return
    if (UNSPLITTABLE_TEXT.test(added)) {
      blocked = true
      return
    }
    let position = lineStart
    while (position < source.length) {
      const newline = source.indexOf('\n', position)
      if (newline < 0) break
      const line = source.slice(position, newline)
      const next = newline + 1
      if (DEFINITION.test(line)) {
        blocked = true
        return
      }
      if (blankBefore && !fence && !math && boundaryBefore(line, true) === 'split') freezeAt(position)
      const blank = BLANK.test(line)
      if (awaitingBlank) {
        if (blank) freezeAt(next)
        awaitingBlank = false
      }
      if (math) {
        if (math === 'dollar' ? DOLLAR_MATH_CLOSER.test(line) : bracketMathEnds(line)) math = null
        blankBefore = false
      } else if (fence) {
        const closer = FENCE_CLOSER.exec(line)
        if (closer && closer[1][0] === fence.char && closer[1].length >= fence.width) {
          awaitingBlank = !fence.indented
          fence = null
        }
        blankBefore = false
      } else {
        const opener = FENCE_OPENER.exec(line)
        const bracketMath = BRACKET_MATH_OPENER.exec(line)
        if (opener && (opener[2][0] === '~' || !opener[3].includes('`'))) {
          fence = { char: opener[2][0], width: opener[2].length, indented: opener[1].length > 0 }
        } else if (DOLLAR_MATH.test(line)) math = 'dollar'
        else if (bracketMath && !bracketMathEnds(line.slice(bracketMath[0].length))) math = 'bracket'
        else readHtml(withoutCodeSpans(line))
        blankBefore = !fence && !math && blank
      }
      if (blocked) return
      position = next
    }
    lineStart = position
    // The line still streaming: enough of it may already say a segment ends
    // before it, and a definition is a definition from its first colon.
    const partial = source.slice(position)
    if (DEFINITION.test(partial)) {
      blocked = true
      return
    }
    if (blankBefore && !fence && !math && boundaryBefore(partial, false) === 'split') freezeAt(position)
  }

  return (source: string) => {
    if (!source.startsWith(seen)) reset()
    if (source.length !== seen.length || !seen) scan(source)
    if (blocked) return { frozen: [], tail: source }
    return { frozen: frozen.slice(), tail: source.slice(segmentStart) }
  }
}

/** Split a whole message once. See `createMarkdownSplitter`. */
export function splitMarkdownSegments(source: string): MarkdownSegments {
  return createMarkdownSplitter()(source)
}

// ── A paragraph at a time ───────────────────────────────────────────────────
//
// Settings ▸ Appearance ▸ Show replies: "A paragraph at a time" draws a reply
// streaming in only as far as its last finished block, so what is on screen
// never reflows under the reader and the unfinished rest is not parsed at all.

// A fence opens at any indentation (one in a list item sits past its marker);
// it closes with the same character, at least as long, at most three spaces
// deeper than its opener and with nothing after it.
const HELD_FENCE = /^( *)(`{3,}|~{3,})(.*)$/u
// A list item's marker and the space after it, at any depth, read where a
// line starts. The space is required, so a `-` or `1.` still streaming is not
// an item yet.
const LIST_ITEM_START = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/uy
// A section title: an ATX heading, or a line of bold text alone (with an
// optional colon), which replies often use as one.
const SECTION_TITLE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/u
// An ATX heading at the margin ends the block above it with no blank line between.
const TOP_LEVEL_HEADING = /^#{1,6}(?:[ \t]|$)/u

/**
 * How much of a streaming reply is finished: the text up to its last
 * boundary that is not inside an open code fence or display math block. A
 * boundary falls
 *  - after a blank line,
 *  - after a closing code fence,
 *  - before a list item (on the line still streaming too, once its marker
 *    and the space after it are in: a tight list has no blank lines, and would
 *    otherwise land whole), and
 *  - before a heading at the margin.
 * A section title (a heading, or a line of bold text) holds the boundary
 * until a line of content follows it, so a title never shows alone above a
 * block that is still being written. A line ending `\r\n` reads as one ending
 * `\n`.
 *
 * Like `createMarkdownSplitter` it keeps its place: given the text it saw last
 * with more appended, it reads only the lines the new text finished, and
 * while nothing new is finished it answers with the same string as before, so
 * whatever renders it can tell at once that nothing changed. Given anything
 * else it starts over.
 */
export function createParagraphHold(): (source: string) => string {
  let seen = ''
  let shown = ''
  let lineStart = 0
  let boundary = 0
  let fence: { char: string; width: number; indent: number } | null = null
  let math: 'dollar' | 'bracket' | null = null
  let titleAwaitingContent = false
  // A line that is not blank has been read: before one, there is nothing to end.
  let content = false

  const reset = () => {
    seen = ''
    shown = ''
    lineStart = 0
    boundary = 0
    fence = null
    math = null
    titleAwaitingContent = false
    content = false
  }

  // A list item starting at `start` ends what came before it. Read in place,
  // so the line still streaming, however long, is never copied.
  const listItemBoundary = (source: string, start: number) => {
    if (fence || math || !content || titleAwaitingContent) return
    LIST_ITEM_START.lastIndex = start
    if (LIST_ITEM_START.test(source)) boundary = start
  }

  const readLine = (source: string, start: number, newline: number) => {
    listItemBoundary(source, start)
    const line = source.slice(start, newline).replace(/[ \t\r]+$/u, '')
    const next = newline + 1
    const previousContent = content
    content ||= line !== ''
    if (math) {
      if (math === 'dollar' ? DOLLAR_MATH_CLOSER.test(line) : bracketMathEnds(line)) math = null
      return
    }
    const fenceLine = HELD_FENCE.exec(line)
    if (fence) {
      if (
        fenceLine &&
        fenceLine[2][0] === fence.char &&
        fenceLine[2].length >= fence.width &&
        fenceLine[1].length <= fence.indent + 3 &&
        fenceLine[3] === ''
      ) {
        fence = null
        boundary = next
      }
      return
    }
    // A backtick fence's info string holds no backtick; one that does is a code span.
    if (fenceLine && (fenceLine[2][0] === '~' || !fenceLine[3].includes('`'))) {
      fence = { char: fenceLine[2][0], width: fenceLine[2].length, indent: fenceLine[1].length }
      titleAwaitingContent = false
      return
    }
    if (line === '') {
      if (previousContent && !titleAwaitingContent) boundary = next
      return
    }
    const bracketMath = BRACKET_MATH_OPENER.exec(line)
    if (DOLLAR_MATH.test(line)) math = 'dollar'
    else if (bracketMath && !bracketMathEnds(line.slice(bracketMath[0].length))) math = 'bracket'
    if (previousContent && !titleAwaitingContent && TOP_LEVEL_HEADING.test(line)) boundary = start
    titleAwaitingContent = SECTION_TITLE.test(line)
  }

  return (source: string) => {
    if (!source.startsWith(seen)) reset()
    seen = source
    let position = lineStart
    for (let newline = source.indexOf('\n', position); newline >= 0; newline = source.indexOf('\n', position)) {
      readLine(source, position, newline)
      position = newline + 1
    }
    lineStart = position
    // Only the marker of the line still streaming is read: the rest of it is not finished.
    listItemBoundary(source, position)
    if (boundary !== shown.length) shown = source.slice(0, boundary)
    return shown
  }
}
