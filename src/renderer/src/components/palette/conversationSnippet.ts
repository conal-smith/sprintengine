import type { ConversationSearchHit } from '../../../../shared/conversation-index'

// The line under a conversation the palette found by what was said in it: the
// sentence that matched, cut so the match is on screen, and the parts of it
// that are the match. Pure, so what a row says is asserted without a palette.

/**
 * How much of what comes before the match a snippet keeps. The shell is 600px
 * wide and the line truncates at its end, so the match has to sit near the
 * start: the main process's window keeps 80 characters ahead of it, which on
 * a narrow window pushed the match past the ellipsis.
 */
export const SNIPPET_LEAD_CHARS = 40

/**
 * The snippet as one line with the match near its start, or null when the
 * text does not contain the query — the palette only ever shows a line that
 * says why the row is there.
 *
 * Whitespace runs (a reply's paragraphs, a message's line breaks) read as one
 * space, the way a truncated line draws them anyway. An ellipsis says the
 * text was cut: in front when it starts mid-message, at the end when the
 * window the main process sent stopped before the message did.
 */
export function shapeSnippet(raw: string, query: string): string | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  let text = raw.replace(/\s+/gu, ' ').trim()
  const cutBefore = text.startsWith('…')
  const cutAfter = text.endsWith('…')
  if (cutBefore) text = text.slice(1).trimStart()
  if (cutAfter) text = text.slice(0, -1).trimEnd()
  const at = text.toLowerCase().indexOf(needle)
  if (at === -1) return null
  let start = at > SNIPPET_LEAD_CHARS ? at - SNIPPET_LEAD_CHARS : 0
  if (start > 0) {
    // Start on a word, not inside one, when there is a break to start at.
    const space = text.indexOf(' ', start)
    if (space !== -1 && space < at) start = space + 1
  }
  return `${start > 0 || cutBefore ? '…' : ''}${text.slice(start)}${cutAfter ? '…' : ''}`
}

/** True when a snippet still contains the query: a row kept from an earlier keystroke is still a true answer. */
export function snippetContains(snippet: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle.length > 0 && snippet.toLowerCase().includes(needle)
}

export type MatchSegment = { text: string; match: boolean }

/**
 * The text split into the runs that are the query and the runs that are not,
 * case-insensitively, every occurrence. A text without the query is one plain
 * run, so a caller can always render the segments.
 */
export function matchSegments(text: string, query: string): MatchSegment[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const haystack = text.toLowerCase()
  const segments: MatchSegment[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (at > from) segments.push({ text: text.slice(from, at), match: false })
    segments.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length || segments.length === 0) segments.push({ text: text.slice(from), match: false })
  return segments
}

const FROM_RANK: Record<NonNullable<ConversationSearchHit['from']>, number> = { person: 0, agent: 1, studio: 2 }

/**
 * The one message a conversation's row shows when several matched: what the
 * person wrote before what the agent did — someone searching for a chat
 * remembers what they said in it — then the most recent. A hit from a host
 * that does not say who wrote it ranks with Studio's.
 */
export function bestConversationHit<T extends Pick<ConversationSearchHit, 'seq' | 'from'>>(
  hits: readonly T[],
): T | null {
  let best: T | null = null
  for (const hit of hits) {
    if (!best) {
      best = hit
      continue
    }
    const rank = FROM_RANK[hit.from ?? 'studio'] - FROM_RANK[best.from ?? 'studio']
    if (rank < 0 || (rank === 0 && hit.seq > best.seq)) best = hit
  }
  return best
}

/** Who said it, as the line opens: the person is "You", as in their own transcript. */
export function snippetSpeaker(from: ConversationSearchHit['from']): string | null {
  if (from === 'person') return 'You'
  if (from === 'agent') return 'Agent'
  if (from === 'studio') return 'Studio'
  return null
}
