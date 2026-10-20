import { basename } from 'node:path'

import { INJECTED_FRAGMENT_PATTERNS } from '../../shared/workspace-title'

/**
 * Turn what a person actually typed into the sentence a hover card can quote.
 *
 * The card quotes ONE message in full and one line of every message after it,
 * so the text it is handed has to already be the sentence — not the sentence
 * plus the 400-line file they pasted under it, not the sentence plus the four
 * repo paths they dropped onto the terminal. Collapsing happens BEFORE the
 * character cap for exactly that reason: capping first would spend the whole
 * budget on a fenced block and truncate away the request itself, and the card
 * would then honestly report "+3,900 more" about text nobody typed.
 *
 * A path-shaped token is shortened to its basename rather than deleted: a
 * dropped file is part of what the person asked, and "read USAGE.md" says so in
 * less room than the full path. That is the difference between this module and
 * `stripInjectedFragments`, whose consumer (the derived title) throws paths
 * away. Both read the same patterns (`INJECTED_FRAGMENT_PATTERNS`) so the two
 * routes cannot disagree about what counts as a path.
 *
 * Pure: no I/O, no Electron, no DOM. Every input is untrusted — the text comes
 * from a CLI's hook report, written by another process.
 */

export type CollapsedPeekText = {
  /** The sentence, whitespace-normalised, uncapped. */
  text: string
  /**
   * Characters dropped before collapsing even started, because the input was
   * past {@link MAX_COLLAPSE_INPUT_CHARS}. The caller adds these to the
   * message's `truncatedChars`, so a card that says "+40,000 more" is counting
   * everything it did not show rather than only the tail the cap ate.
   */
  overflowChars: number
}

/**
 * Wrappers the CLI puts around something that is not a person speaking:
 * a slash-command invocation, a background task report, the echo of a `!` bash
 * line. The fragment is removed and the rest of the message kept.
 */
const INJECTED_TAG_PATTERN =
  /<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|task-id|tool-use-id|output-file|status|summary)>/gi

/**
 * A line that is only a path is a drop, not a sentence. Recognised separately
 * from the inline patterns because a bare `design-system/` on its own line has
 * no leading whitespace for `explicitPath`/`barePath` to anchor on.
 */
const WHOLE_LINE_PATH_PATTERN = /^\s*(@?~?\.{0,2}\/?[\w.@+-]+(?:\/[\w.@+-]*)+)\s*$/

/** Longest token still treated as a path. Past this it is a paste, not a filename. */
const MAX_PATH_TOKEN_LENGTH = 512

/**
 * Longest text collapsed in full. Two orders of magnitude above the longest
 * message anyone types, and there so a person who pasted five megabytes into a
 * prompt cannot make a hover run several regexes over all of it. Past this the
 * head is collapsed and the rest is counted, which is the same answer the cap
 * would have reached anyway — only without the work.
 */
export const MAX_COLLAPSE_INPUT_CHARS = 128 * 1024

/**
 * The sentence inside `input`, with fenced blocks, injected wrappers and image
 * placeholders removed and path-shaped tokens shortened to their basenames.
 */
export function collapsePeekText(input: string): CollapsedPeekText {
  const overflowChars = Math.max(0, input.length - MAX_COLLAPSE_INPUT_CHARS)
  const raw = overflowChars > 0 ? input.slice(0, MAX_COLLAPSE_INPUT_CHARS) : input
  /**
   * Shorten `token` to its basename, or leave `fallback` in place when it is
   * not actually a path. The decision is made on the CLEANED token, so
   * "src/main/app.ts," is recognised and its comma is not what disqualifies it.
   *
   * A path leaves its LABEL behind in the sentence, not a hole. This is the
   * marquee element of the surface — the card quotes the first message in
   * full — and deleting the token mid-clause corrupts what the person wrote:
   * "attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css`"
   * became "attached at ; read USAGE.md + +", which reads as though the app
   * damaged the message.
   *
   * `mode: 'drop'` is for a token that is a whole line on its own — a dropped
   * file, not a word in a sentence. There is no clause to keep readable there,
   * and a stray basename on its own line is noise.
   */
  const take = (token: string, fallback: string, mode: 'label' | 'drop' = 'label'): string => {
    const cleaned = normalisePathToken(token)
    if (!cleaned || !looksLikePath(cleaned)) return fallback
    const label = basename(cleaned.replace(/\/+$/, '')) || cleaned
    return mode === 'drop' ? ' ' : ` ${label} `
  }

  const patterns = INJECTED_FRAGMENT_PATTERNS
  const withoutBulk = raw
    // Order matters: fences first, so a path INSIDE a pasted diff is dropped
    // with the diff rather than surviving as a label.
    .replace(patterns.fencedBlock, ' ')
    .replace(INJECTED_TAG_PATTERN, ' ')
    // The card shows text only, so a placeholder naming an image it cannot
    // show is noise in the quote.
    .replace(patterns.imagePlaceholder, ' ')

  const lines = withoutBulk.split('\n').map((line) => {
    const wholeLine = WHOLE_LINE_PATH_PATTERN.exec(line)
    if (wholeLine?.[1]) return take(wholeLine[1], line, 'drop')
    return (
      line
        // Inline code is where a dropped path most often lands ("read `USAGE.md`"),
        // so its contents are inspected rather than deleted wholesale: a path is
        // shortened, and anything else keeps its place in the sentence unquoted.
        .replace(patterns.inlineCode, (match) => {
          const inner = match.slice(1, -1).trim()
          return take(inner, ` ${inner} `)
        })
        .replace(patterns.mention, (match) => take(match.trim().slice(1), match))
        .replace(patterns.explicitPath, (match) => take(match.trim(), match))
        .replace(patterns.barePath, (match) => take(match.trim(), match))
    )
  })

  const text = lines
    .join('\n')
    // Runs of blank lines collapse to one: a card is a few lines tall, and the
    // vertical space a pasted layout leaves behind is space the sentence needs.
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n[ \t]*(?:\n[ \t]*)+/g, '\n\n')
    // Every substitution above pads with a space, which strands the punctuation
    // that followed the token ("design-system ;"). Reunite it — the whole point
    // of substituting a label was that the sentence still reads.
    .replace(/[ \t]+([,.;:!?)\]}])/g, '$1')
    .replace(/([([{]) +/g, '$1')
    .trim()

  return { text, overflowChars }
}

/**
 * `text` cut to `maxChars`, plus how much was cut. The ellipsis is deliberately
 * NOT added here: the renderer draws the "…" and the remainder count together,
 * and a main-side ellipsis would either double up or lie about the count by one.
 */
export function capPeekText(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) return { text, truncatedChars: 0 }
  // Break on a word boundary when one is close, so the quote does not end
  // mid-identifier; fall back to the hard cut when the tail is one long token.
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = (lastSpace > maxChars - 24 ? cut.slice(0, lastSpace) : cut).trimEnd()
  return { text: kept, truncatedChars: text.length - kept.length }
}

/**
 * Whether a token pulled out of inline code or an @-mention is path-shaped
 * enough to shorten. Stricter than the strip patterns on purpose: a title that
 * eats "and/or" loses two words, whereas a quote that turns "and/or" into "or"
 * has changed what the person said.
 */
function looksLikePath(token: string): boolean {
  if (!token || token.length > MAX_PATH_TOKEN_LENGTH || /\s/.test(token)) return false
  if (isUrlFragment(token)) return false
  if (/^[~.]{0,2}\//.test(token)) return true
  if (!token.includes('/')) return false
  // A bare token needs a file-ish tail or a trailing slash to count: "src/main"
  // is ambiguous prose, "src/main/app.ts" and "design-system/" are not.
  return /\.[A-Za-z0-9]{1,12}$/.test(token) || token.endsWith('/')
}

function isUrlFragment(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token.trim())
}

function normalisePathToken(token: string): string | null {
  const cleaned = token
    .trim()
    .replace(/^@/, '')
    .replace(/[),.;:'"]+$/, '')
  if (!cleaned || cleaned.length > MAX_PATH_TOKEN_LENGTH || cleaned.includes('\0')) return null
  return cleaned
}
