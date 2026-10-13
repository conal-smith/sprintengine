import { ansiPlainText } from '../../shared/conversation/ansi'

/**
 * What `ansiPlainText` leaves that is still not text: C0 controls other than
 * tab and newline (a BEL, a vertical tab, a stray NUL), DEL, and the C1 range.
 * Colour, cursor and OSC sequences are already gone by then, and a carriage
 * return or backspace has already been applied to the row it moved on.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const LEFTOVER_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

export type TerminalPlainText = { text: string; lineCount: number; truncated: boolean }

/**
 * A terminal's raw output as the plain text an agent can read: escapes
 * stripped, a progress line its `\r` redraws left as it ended, trailing blanks
 * off every row and off the end, then the newest `maxLines` lines and at most
 * `maxChars` characters of them. `truncated` says that either limit left older
 * lines out; a read that was cut before it got here says so on its own.
 *
 * Plain text rather than the escapes because the reader is a model: `[31m`
 * costs tokens and says nothing, and the colour it carried (an error is red)
 * is almost always repeated in the words.
 */
export function terminalPlainText(raw: string, limits: { maxLines: number; maxChars: number }): TerminalPlainText {
  const rows = ansiPlainText(raw)
    .replace(LEFTOVER_CONTROLS, '')
    .split('\n')
    .map((row) => row.trimEnd())
  let end = rows.length
  // The row the cursor sits on after a final newline is empty, and so is the
  // space a TUI cleared below its last line; neither is a line of output.
  while (end > 0 && rows[end - 1] === '') end -= 1
  const start = Math.max(0, end - limits.maxLines)
  let text = rows.slice(start, end).join('\n')
  let truncated = start > 0
  if (text.length > limits.maxChars) {
    text = text.slice(text.length - limits.maxChars)
    // From the first whole line, unless the budget holds less than one.
    const newline = text.indexOf('\n')
    if (newline !== -1) text = text.slice(newline + 1)
    truncated = true
  }
  return { text, lineCount: text === '' ? 0 : countNewlines(text) + 1, truncated }
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1
  return count
}
