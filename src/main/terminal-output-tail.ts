import { resyncTerminalReplayHead, type TerminalSession } from './terminal-session'

/**
 * The newest part of a session's retained output, for a reader that wants "what
 * did it print lately" rather than the whole scrollback: `terminal.read`, which
 * an agent polls to follow a dev server's log.
 *
 * `text` is raw — escapes intact — and starts at a whole line when anything
 * older was left out. `cursor` is the stream position it ends at (UTF-16 units,
 * `output.appendedUnits`, the same count `readTerminalOutputSince` uses), to be
 * passed back as `since` so the next read returns only what came after.
 * `truncated` says that output older than `text`, or part of the gap since
 * `since`, is not in it: cut by `maxBytes`, or already evicted from the buffer.
 */
export type TerminalOutputTail = { text: string; cursor: number; truncated: boolean }

/**
 * How far into a cut read to look for a line start. Past it the head is kept
 * as it is (escape-resynced): a log of one enormous line — a minified bundle
 * printed whole, a progress bar redrawn with carriage returns — would otherwise
 * lose nearly all of what was read for the sake of one partial line.
 */
const LINE_START_WINDOW = 8 * 1024

/**
 * At most `maxBytes` of the newest retained output, decoding only that much:
 * the replay buffer's `tail` reads from the end, so a read costs what it
 * returns and never the multi-megabyte scrollback behind it.
 *
 * With `since`, only what was appended after that cursor, still bounded by
 * `maxBytes` (the newest part wins). A cursor past the end of the stream is not
 * one this session handed out — a respawn under the same id starts its count
 * again — so it is read as no cursor at all rather than as "nothing new"
 * forever.
 *
 * A session whose raw stream was let go once its screen was rendered (a paused
 * or settled agent, `replaySnapshot`) answers from that rendered screen, as
 * `readTerminalOutputSince` does: a reader that had not seen the end of the
 * stream gets the last screen, which may repeat text it already had, and one
 * that had gets nothing, since nothing can be appended to a dead stream.
 */
export function readTerminalOutputTail(
  session: Pick<TerminalSession, 'output' | 'replaySnapshot'>,
  options: { maxBytes: number; since?: number },
): TerminalOutputTail {
  const output = session.output
  const end = output.appendedUnits
  const since = options.since !== undefined && options.since <= end ? options.since : undefined
  const maxBytes = Math.max(1, Math.floor(options.maxBytes))

  if (output.retainedBytes === 0 && session.replaySnapshot) {
    if (since !== undefined && since >= end) return { text: '', cursor: end, truncated: false }
    const snapshot = session.replaySnapshot
    // A rendered screen is a string already, so its budget is counted in
    // characters; a slice of it shares the snapshot's storage.
    if (snapshot.length <= maxBytes) return { text: snapshot, cursor: end, truncated: false }
    return { text: fromWholeLine(snapshot.slice(snapshot.length - maxBytes)), cursor: end, truncated: true }
  }

  if (since === undefined) {
    const { text, cut } = output.tail(maxBytes)
    // `output.truncated` is sticky: the head of the buffer was evicted at some
    // point, so even an uncut tail starts after output the reader never sees.
    const truncated = cut || output.truncated
    return withoutUnfinishedEscape(truncated ? fromWholeLine(text) : text, end, truncated)
  }

  const retainedFrom = end - output.retainedUnits
  const from = Math.max(since, retainedFrom)
  const wanted = end - from
  if (wanted <= 0) return { text: '', cursor: end, truncated: false }
  // No UTF-16 unit takes more than three UTF-8 bytes, so the newest
  // `wanted * 3` bytes always hold the `wanted` units asked for; the budget
  // only bites when the gap is larger than it.
  const read = output.tail(Math.min(wanted * 3, maxBytes)).text
  const text = read.length > wanted ? read.slice(read.length - wanted) : read
  const truncated = since < retainedFrom || text.length < wanted
  return withoutUnfinishedEscape(truncated ? fromWholeLine(text) : text, end, truncated)
}

/**
 * The read without an escape sequence it ends in the middle of, and the cursor
 * moved back to where that sequence starts. A pty chunk boundary is not an
 * escape boundary, so a read taken between two chunks can end on `ESC[3` with
 * `2m` still to come; handed out as it is, the next read would begin with a
 * stray `2m` that no stripping can recognise. Held back, the next read starts
 * at the ESC and sees the sequence whole.
 */
function withoutUnfinishedEscape(text: string, cursor: number, truncated: boolean): TerminalOutputTail {
  const held = unfinishedEscapeLength(text)
  if (held === 0) return { text, cursor, truncated }
  return { text: text.slice(0, text.length - held), cursor: cursor - held, truncated }
}

/** How far back from the end an unfinished sequence is looked for; an OSC hyperlink is the longest in practice. */
const UNFINISHED_ESCAPE_WINDOW = 4 * 1024

/** How many characters at the end of `text` are an escape sequence not yet finished; 0 when it ends on a whole one. */
export function unfinishedEscapeLength(text: string): number {
  const escape = text.lastIndexOf('\x1b')
  if (escape === -1 || escape < text.length - UNFINISHED_ESCAPE_WINDOW) return 0
  const unfinished = text.length - escape
  const kind = text[escape + 1]
  if (kind === undefined) return unfinished
  if (kind === '[') {
    // CSI: parameters and intermediates, then one final byte in 0x40–0x7e.
    for (let index = escape + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return 0
    }
    return unfinished
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    // OSC / DCS / APC / PM / SOS end with BEL or ST (`ESC \`). An ST would be
    // the last ESC itself, so only a BEL can have finished this one.
    return text.indexOf('\x07', escape + 2) === -1 ? unfinished : 0
  }
  if (kind >= ' ' && kind <= '/') {
    // Intermediate bytes (`ESC ( B` selects a character set) run until a final byte.
    let index = escape + 1
    while (index < text.length && text[index]! >= ' ' && text[index]! <= '/') index += 1
    return index >= text.length ? unfinished : 0
  }
  return 0
}

/**
 * A cut read from its first whole line. A cut lands wherever the byte budget
 * fell, which is mid-line and often mid-escape; a reader shown half a line
 * takes it for the whole of one. Without a newline near the head, it falls
 * back to the replay's own resync, which at least never starts inside an
 * escape sequence.
 */
function fromWholeLine(text: string): string {
  const newline = text.indexOf('\n')
  if (newline !== -1 && newline < LINE_START_WINDOW) return text.slice(newline + 1)
  return resyncTerminalReplayHead(text)
}
