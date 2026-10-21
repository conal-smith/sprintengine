import { FENCE_CLOSER, FENCE_OPENER } from './markdownFileLinks'

// Claude Code's Explanatory and Learning output styles frame a teaching note
// as a block of lines joined by single newlines:
//
//   `★ Insight ─────────────────────────────────────`
//   - The first point
//   - The second point
//   `─────────────────────────────────────────────────`
//
// Markdown folds a single newline into a space, so the frame and the lines
// after it ran together as one paragraph, and the closing rule, a lazy
// continuation of the last bullet, sat inside it. Inside the block each line
// keeps its break, and the closing rule stands on its own. The rest of the
// reply is untouched.

const OPENER = /^ {0,3}`?★ Insight(?:[\s─`]|$)/u
const CLOSER = /^ {0,3}`?─{3,}`?[ \t]*$/u
const HARD_BREAK = /(?: {2}|\\)$/u

export function keepInsightLineBreaks(markdown: string): string {
  // design-tokens-allow: the star is text the CLI writes and this looks for, never drawn as an icon
  if (!markdown.includes('★ Insight')) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: { char: string; width: number } | null = null
  let inside = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      const closer = FENCE_CLOSER.exec(line)
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.width) fence = null
      out.push(line)
      continue
    }
    const opener = !inside ? FENCE_OPENER.exec(line) : null
    if (opener && (opener[1][0] === '~' || !line.slice(opener[0].length).includes('`'))) {
      fence = { char: opener[1][0], width: opener[1].length }
      out.push(line)
      continue
    }
    if (!inside) {
      inside = OPENER.test(line)
      out.push(inside ? withBreak(line, lines[index + 1]) : line)
      continue
    }
    if (CLOSER.test(line)) {
      inside = false
      if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
      out.push(line)
      continue
    }
    out.push(withBreak(line, lines[index + 1]))
  }
  return out.join('\n')
}

/** A hard break at the end of `line` when another line of the block follows it. */
function withBreak(line: string, next: string | undefined): string {
  if (line.trim() === '' || next === undefined || next.trim() === '' || CLOSER.test(next)) return line
  return HARD_BREAK.test(line) ? line : `${line}  `
}
