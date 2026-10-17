// Find in chat: which words of a conversation a find searches, and where its
// matches are. Pure — the chat view's hook (useChatFind) owns the state, and
// chatFindHighlight paints whatever of this is on screen.
//
// The search runs over the rows' DATA, not the page. The transcript is a
// virtualized list, so most of a long chat is not in the DOM at all, and the
// browser's own find-in-page would also match the composer and every button
// label. A row the list has not drawn is searched the same as one it has.
//
// What is searched, per row the chat has loaded:
//   - what the person wrote (their messages, not Studio's notices);
//   - each reply's final prose, the text under the turn's fold;
//   - each plan the agent proposed, as its card shows it.
// What is not, in this first cut:
//   - the steps a turn took and what they printed, and the prose and thinking
//     written between them, which all live behind the turn's fold;
//   - older history the chat has not paged in yet ("Load earlier"). Paging it
//     all in to answer a keystroke would fetch the whole log on every find; a
//     person who wants an old turn loads it, and the find picks it up.

import { showCodexFollowupLabels } from '../../../utils/markdownCodexFollowups'
import { chatFindSegmentKey } from './chatFindSegment'
import type { ConversationTimelineRow } from './conversationTimeline'
import { planBody, planTitle } from './planCard'

/** Past this the count stops and reads "1000+": a find is for locating, not for census. */
export const CHAT_FIND_MATCH_CAP = 1000

export type ChatFindSegment = {
  key: string
  /** The segment's text as a find compares it (`foldForFind` over `markdownSearchText`). */
  text: string
}

export type ChatFindMatch = {
  rowId: string
  /** The row's index in the rows the matches were found in. */
  rowIndex: number
  segment: string
  /** Which occurrence within the segment, from 0. */
  ordinal: number
}

export type ChatFindResults = {
  matches: ChatFindMatch[]
  /** True when there were more than `CHAT_FIND_MATCH_CAP`. */
  capped: boolean
  /** Every searched segment's folded text, for checking a match against the page. */
  segments: ReadonlyMap<string, string>
}

export const NO_CHAT_FIND_RESULTS: ChatFindResults = { matches: [], capped: false, segments: new Map() }

// ── Folding ───────────────────────────────────────────────────────────────

/**
 * Builds the string a find compares, one character at a time: case folded, and
 * every run of whitespace one space, with none at either end. Each character
 * kept carries a caller's tag (the DOM side tags it with its text node and
 * offset), so a match found in the folded string maps back to what it came
 * from.
 *
 * Case folds per character and keeps the original where lowercasing would
 * change the length ('İ' lowercases to two code units): a folded string the
 * same length as its tags is what makes the mapping exact.
 */
export function createFindFolder<Tag>() {
  const chars: string[] = []
  const tags: (Tag | null)[] = []
  let pendingSpace = false
  return {
    push(char: string, tag: Tag | null) {
      if (/\s/u.test(char)) {
        pendingSpace = chars.length > 0
        return
      }
      if (pendingSpace) {
        chars.push(' ')
        tags.push(null)
        pendingSpace = false
      }
      const lower = char.toLowerCase()
      chars.push(lower.length === char.length ? lower : char)
      tags.push(tag)
    },
    /** A boundary the page draws as a break (a block, a <br>): whitespace without a character. */
    separate() {
      pendingSpace = chars.length > 0
    },
    result(): { text: string; tags: (Tag | null)[] } {
      return { text: chars.join(''), tags }
    },
  }
}

export function foldForFind(text: string): string {
  const folder = createFindFolder<null>()
  // Per code unit, as the page side reads its text nodes, so both fold alike.
  for (let index = 0; index < text.length; index++) folder.push(text[index]!, null)
  return folder.result().text
}

/** Where `query` occurs in `text`, without overlapping, up to `limit` occurrences. */
export function occurrences(text: string, query: string, limit = Number.POSITIVE_INFINITY): number[] {
  const found: number[] = []
  if (!query) return found
  let from = 0
  while (found.length < limit) {
    const at = text.indexOf(query, from)
    if (at < 0) break
    found.push(at)
    from = at + query.length
  }
  return found
}

// ── What the page shows of a message's markdown ───────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})/u
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|>~<])/gu
// Private-use stand-ins for escaped punctuation, so the emphasis pass below
// cannot mistake `\*` for markup. Restored at the end.
const STAND_IN_BASE = 0xe000

/**
 * The words a markdown message renders as, close enough that counting a query
 * in it agrees with counting it on the page: link and image targets dropped for
 * their labels, emphasis and code markers dropped, block markers (headings,
 * quotes, list bullets, table rules) dropped, and code kept verbatim.
 *
 * It is a reading, not a parser. Where it and the page disagree — a file path
 * the page draws as a chip with only its name, a formula — the count still
 * counts the match, and the page has one fewer to highlight; `useChatFind`
 * then lands on the row rather than on the word.
 */
export function markdownSearchText(markdown: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of markdown.split(/\r?\n/u)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
      else out.push(line)
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    out.push(inlineSearchText(blockSearchText(line)))
  }
  return out.join('\n')
}

function blockSearchText(line: string): string {
  // A thematic break or a table's delimiter row draws no text.
  if (/^ {0,3}([-*_])( *\1){2,} *$/u.test(line)) return ''
  if (/^ *\|? *:?-{3,}:? *(\| *:?-{3,}:? *)*\|? *$/u.test(line) && line.includes('-')) return ''
  let text = line
  // Quote markers, nested or not.
  text = text.replace(/^( {0,3}> ?)+/u, '')
  text = text.replace(/^ {0,3}#{1,6}(?: +|$)/u, '').replace(/ +#+ *$/u, '')
  text = text.replace(/^ *(?:[-*+]|\d{1,9}[.)]) +(?:\[[ xX]\] +)?/u, '')
  // A table row's cells: the pipes are the table's lines, not its text.
  if (/^ *\|/u.test(text)) text = text.replace(/(?<!\\)\|/gu, ' ')
  return text
}

function inlineSearchText(line: string): string {
  // Code spans keep their content as written; only the prose between them is
  // read for markup.
  const parts = line.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/u)
  let text = ''
  for (let index = 0; index < parts.length; index += 3) {
    text += proseSearchText(parts[index] ?? '')
    const code = parts[index + 2]
    if (code !== undefined) text += code
  }
  return text
}

function proseSearchText(prose: string): string {
  const escaped: string[] = []
  let text = prose.replace(ESCAPED, (_, char: string) => {
    escaped.push(char)
    return String.fromCharCode(STAND_IN_BASE + escaped.length - 1)
  })
  // Labels and destinations stop at the next `[`: without that, every `[`
  // on a line with no `]` (a pasted log's `\x1b[32m`), or every `](` with no
  // `)`, reads on to the line's end, and a long line costs its length squared.
  // A bracket inside a label is the page's text anyway; the link is the
  // innermost `[…](…)`, as the renderer draws it.
  text = text
    .replace(/!\[([^[\]]*)\]\([^)[]*\)/gu, '$1')
    .replace(/\[([^[\]]+)\]\([^)[]*\)/gu, '$1')
    .replace(/\[([^[\]]+)\]\[[^[\]]*\]/gu, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gu, '$1')
    .replace(/(\*\*|__|~~)/gu, '')
    // A lone `*` or `_` is emphasis only against a word; `2 * 3` and
    // `snake_case` are text, and the page shows them.
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)/gu, '$1')
    .replace(/(?<=\S)\*(?=[^\p{L}\p{N}*]|$)/gu, '')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)/gu, '$1')
    .replace(/(?<=\S)_(?=[^\p{L}\p{N}_]|$)/gu, '')
  return text.replace(/[-]/gu, (char) => escaped[char.charCodeAt(0) - STAND_IN_BASE] ?? char)
}

// ── The index ─────────────────────────────────────────────────────────────

/**
 * The searched segments of one row, in the order the row draws them. Kept per
 * row object: the timeline keeps a row's identity until its content changes,
 * so a reply streaming at the bottom is the only row read again on a recount.
 */
const segmentCache = new WeakMap<ConversationTimelineRow, ChatFindSegment[]>()

export function chatFindSegments(row: ConversationTimelineRow): ChatFindSegment[] {
  const cached = segmentCache.get(row)
  if (cached) return cached
  const segments: ChatFindSegment[] = []
  const add = (key: string, markdown: string) => {
    const text = foldForFind(markdownSearchText(markdown))
    if (text) segments.push({ key, text })
  }
  if (row.kind === 'user') {
    if (row.entry.origin?.kind !== 'studio' && row.entry.text.trim())
      add(chatFindSegmentKey.user(row.entry.id), row.entry.text)
  }
  if (row.kind === 'assistant' || row.kind === 'approval') {
    // Decisions draw above the reply's prose, so their plans come first.
    for (const decision of row.decisions) {
      if (decision.kind !== 'decision') continue
      const { entry } = decision
      if (entry.requestKind !== 'plan' || !entry.plan?.trim()) continue
      // The card's title line, then its body: the heading the card lifts into
      // its title is not drawn a second time.
      add(chatFindSegmentKey.plan(entry.requestId), `${planTitle(entry.plan) ?? ''}\n\n${planBody(entry.plan)}`)
    }
  }
  // A follow-up Codex suggests is drawn as its label; the prompt behind it is
  // not on the page to find.
  if (row.kind === 'assistant' && row.entry.text.trim())
    add(chatFindSegmentKey.reply(row.entry.turnId), showCodexFollowupLabels(row.entry.text))
  segmentCache.set(row, segments)
  return segments
}

/** The query as a find compares it, or '' when there is nothing to look for. */
export function chatFindQuery(raw: string): string {
  return foldForFind(raw)
}

/** Every match of `query` (already folded) in `rows`, in reading order. */
export function findInChat(
  rows: readonly ConversationTimelineRow[],
  query: string,
  cap = CHAT_FIND_MATCH_CAP,
): ChatFindResults {
  if (!query) return NO_CHAT_FIND_RESULTS
  const matches: ChatFindMatch[] = []
  const segments = new Map<string, string>()
  let capped = false
  for (let rowIndex = 0; rowIndex < rows.length && !capped; rowIndex++) {
    const row = rows[rowIndex]!
    for (const segment of chatFindSegments(row)) {
      segments.set(segment.key, segment.text)
      // One past the cap, to know whether the cap was reached or exceeded.
      const found = occurrences(segment.text, query, cap + 1 - matches.length)
      for (let ordinal = 0; ordinal < found.length; ordinal++) {
        if (matches.length === cap) {
          capped = true
          break
        }
        matches.push({ rowId: row.id, rowIndex, segment: segment.key, ordinal })
      }
      if (capped) break
    }
  }
  return { matches, capped, segments }
}

// ── Moving through the matches ────────────────────────────────────────────

/**
 * Where a new query starts: the first match at or below the top of what the
 * reader is looking at, wrapping to the first match of all when there is none
 * below. -1 with no matches.
 */
export function firstMatchFrom(matches: readonly ChatFindMatch[], firstVisibleRow: number): number {
  if (matches.length === 0) return -1
  const below = matches.findIndex((match) => match.rowIndex >= firstVisibleRow)
  return below >= 0 ? below : 0
}

/** One step forward or back, wrapping at either end. */
export function stepMatch(index: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (index < 0) return direction === 1 ? 0 : count - 1
  return (index + direction + count) % count
}

/**
 * The current match after a recount. A recount happens because the rows
 * changed — a reply streamed on, an earlier page loaded above — and the reader
 * is still looking at the match they were on, so it is found again by what it
 * is (its segment and occurrence) rather than by its position in the list,
 * which a page loaded above shifts. A match whose text is gone gives way to
 * the nearest occurrence left in its segment, else to the same position.
 */
export function reconcileMatch(
  previous: ChatFindMatch | null,
  previousIndex: number,
  matches: readonly ChatFindMatch[],
): number {
  if (matches.length === 0) return -1
  if (!previous) return Math.min(Math.max(previousIndex, 0), matches.length - 1)
  let sameSegment = -1
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!
    if (match.segment !== previous.segment) continue
    if (match.ordinal === previous.ordinal) return index
    if (match.ordinal < previous.ordinal || sameSegment < 0) sameSegment = index
  }
  if (sameSegment >= 0) return sameSegment
  return Math.min(Math.max(previousIndex, 0), matches.length - 1)
}

/** What the count reads. */
export function chatFindStatus(query: string, index: number, results: Pick<ChatFindResults, 'matches' | 'capped'>) {
  if (!query) return ''
  const count = results.matches.length
  if (count === 0) return 'No results'
  const total = results.capped ? `${count}+` : `${count}`
  return index < 0 ? total : `${index + 1} of ${total}`
}
