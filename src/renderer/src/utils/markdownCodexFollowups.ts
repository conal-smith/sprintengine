import { codeSpanEnd, FENCE_CLOSER, FENCE_OPENER } from './markdownFileLinks'

// A follow-up Codex suggests, written as an inline directive:
//
//   - :codex-followup[Prepare print version]{prompt="Make a print-ready version"}
//
// Codex's own terminal draws only the label and keeps the prompt behind it.
// Markdown has no directives, so the reply showed the whole thing as literal
// text, the prompt included. A complete directive reads as its label. One still
// streaming, one with an empty label or prompt, a name that only starts the
// same way, and anything in code are left exactly as written.

const NAME = ':codex-followup['
const DIRECTIVE = /:codex-followup\[((?:\\.|[^\\\]\n])*)\]\{[ \t]*prompt="((?:\\.|[^"\\\n])*)"[ \t]*\}/uy

function labelLine(line: string): string {
  let out = ''
  let from = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '`') {
      index = codeSpanEnd(line, index)
      continue
    }
    if (char !== ':' || !line.startsWith(NAME, index)) continue
    DIRECTIVE.lastIndex = index
    const directive = DIRECTIVE.exec(line)
    if (!directive || !directive[1].trim() || !directive[2].trim()) continue
    out += line.slice(from, index) + directive[1]
    from = index + directive[0].length
    index = from - 1
  }
  return from === 0 ? line : out + line.slice(from)
}

/** `markdown` with each complete Codex follow-up directive replaced by its label. */
export function showCodexFollowupLabels(markdown: string): string {
  if (!markdown.includes(NAME)) return markdown
  let fence: { char: string; width: number } | null = null
  return markdown
    .split('\n')
    .map((line) => {
      if (fence) {
        const closer = FENCE_CLOSER.exec(line)
        if (closer && closer[1][0] === fence.char && closer[1].length >= fence.width) fence = null
        return line
      }
      const opener = FENCE_OPENER.exec(line)
      if (opener && (opener[1][0] === '~' || !line.slice(opener[0].length).includes('`'))) {
        fence = { char: opener[1][0], width: opener[1].length }
        return line
      }
      return line.includes(NAME) ? labelLine(line) : line
    })
    .join('\n')
}
