export type ComposerTrigger = {
  /** `slash` opens the command menu, `skill` Studio's skill picker, `mention` the file picker. */
  kind: 'slash' | 'skill' | 'mention'
  query: string
  range: { start: number; end: number }
}

/** A marker character and what was typed after it, for the token the caret sits in. */
export type ComposerToken = {
  marker: string
  query: string
  range: { start: number; end: number }
}

/**
 * The token under the caret when it opens with one of `markers` at a token
 * boundary: the start of the draft, the start of a line, or after whitespace.
 * Inside a word the character is the word's own — `dev@example.com`, `US$40`,
 * `and/or`, `src/foo` — and opens nothing. The token runs from the marker to
 * the next whitespace, so a pick replaces the whole of it even with the caret
 * part-way through.
 *
 * A token whose query opens with another marker (`//`, `@$`) is not one. A `/`
 * whose query holds another `/` is a path (`/Users/dev/app`, `/src/foo`), not
 * a command or a skill. That holds for the whole token, not only what is
 * before the caret: with the caret moved back into `/et|c/hosts` the path is
 * still a path, and a pick would replace all of it. `https://` never gets this
 * far, its `/` following a colon. A `$` before an amount is money in the same
 * way, read over the whole token too (`isCurrencyAmount`).
 */
export function composerTokenAt(text: string, caret: number, markers: string): ComposerToken | null {
  if (!markers || !Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const match = /(?:^|\s)(\S)(\S*)$/u.exec(text.slice(0, caret))
  if (!match || !markers.includes(match[1])) return null
  const marker = match[1],
    query = match[2]
  if (/[/@$]/u.test(query[0] ?? '') || query[0] === marker) return null
  const start = caret - query.length - 1
  const suffix = text.slice(caret).search(/\s/u)
  const end = suffix < 0 ? text.length : caret + suffix
  if (marker === '/' && text.slice(start + 1, end).includes('/')) return null
  if (marker === '$' && isCurrencyAmount(text.slice(start + 1, end))) return null
  return { marker, query, range: { start, end } }
}

/**
 * `$5`, `$9.99`, `$.99`, `$10k`, `$1,000` and `$2e6` are prices, not skills:
 * digits and their separators, at most one magnitude suffix, and the
 * punctuation prose puts after an amount (`$10k.`, `(about $5)`). A skill's
 * name may start with a digit, so `$1password` and `$2fa` still open the picker
 * once a letter other than a suffix follows, and a bare `$` is no amount.
 */
function isCurrencyAmount(word: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/u.test(word)
}

/**
 * Whether a token starting at `start` opens the message: nothing but blank
 * space before it. A CLI runs a `/command` only there, so a command picked
 * anywhere else has to go in as something the agent reads mid-message.
 */
export function tokenOpensMessage(text: string, start: number): boolean {
  return !text.slice(0, start).trim()
}

/**
 * Token boundaries prevent mail addresses and mid-word punctuation opening a picker.
 *
 * All three markers open where a token can start — the start of the draft, the
 * start of any line, after whitespace — with the caret still inside the token:
 * arguments follow a space, and a space closes the menu so they are typed as
 * plain text. A `/` later in the message opens the command menu too (owner
 * ruling 2026-10-09). A CLI expands a command only when the message opens with
 * it, so what a pick puts there is the menu's to decide (`tokenOpensMessage`).
 */
export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  const token = composerTokenAt(text, caret, '/@$')
  if (!token) return null
  return {
    kind: token.marker === '/' ? 'slash' : token.marker === '$' ? 'skill' : 'mention',
    query: token.query,
    range: token.range,
  }
}
