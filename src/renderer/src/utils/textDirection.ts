export type TextDirection = 'ltr' | 'rtl'

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
const LETTER = /\p{L}/u

/**
 * The direction a block of prose reads in, or undefined when it has no letters
 * to say — a number, a rule of dashes — and takes the direction around it.
 *
 * Each word votes by its first letter and the larger side wins. `dir="auto"`
 * follows the first letter alone, which lays out an Arabic line that opens on
 * an English term (`StrictMode: يعيد الـ render مرتين`) left to right, and that
 * is how a developer writes Arabic or Hebrew most of the time. Counted, such a
 * line reads right to left, and English quoting one Arabic word stays left to
 * right. A tie goes to the first word, as `dir="auto"` would have it.
 */
export function textDirection(text: string): TextDirection | undefined {
  let rtlWords = 0
  let ltrWords = 0
  let first: TextDirection | undefined
  for (const word of text.split(/\s+/u)) {
    const letter = LETTER.exec(word)?.[0]
    if (!letter) continue
    const direction: TextDirection = RTL_LETTER.test(letter) ? 'rtl' : 'ltr'
    first ??= direction
    if (direction === 'rtl') rtlWords += 1
    else ltrWords += 1
  }
  if (rtlWords === ltrWords) return first
  return rtlWords > ltrWords ? 'rtl' : 'ltr'
}
