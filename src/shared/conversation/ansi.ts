export type AnsiColor = { kind: 'palette'; index: number } | { kind: 'rgb'; r: number; g: number; b: number }
export type AnsiSpan = {
  text: string
  fg?: AnsiColor
  bg?: AnsiColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
  strike?: boolean
}
export type AnsiLine = AnsiSpan[]

type Cell = { text: string; style: Omit<AnsiSpan, 'text'> }
export type AnsiState = {
  rows: Cell[][]
  cursor: number
  style: Omit<AnsiSpan, 'text'>
  pending: string
  escapeKind?: 'start' | 'csi' | 'osc' | 'intermediate'
  oscEscape?: boolean
  consumed: number
}

const INPUT_CAP = 2 * 1024 * 1024

function color(value: number): AnsiColor | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? { kind: 'palette', index: value } : undefined
}

function updateStyle(state: AnsiState, params: string): void {
  const values = params === '' ? [0] : params.split(';').map(Number)
  const next = { ...state.style }
  for (let i = 0; i < values.length; i++) {
    const code = values[i]
    if (code === 0) {
      for (const key of Object.keys(next) as Array<keyof typeof next>) delete next[key]
    } else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 9) next.strike = true
    else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) delete next.italic
    else if (code === 24) delete next.underline
    else if (code === 27) delete next.inverse
    else if (code === 29) delete next.strike
    else if (code >= 30 && code <= 37) next.fg = color(code - 30)
    else if (code >= 40 && code <= 47) next.bg = color(code - 40)
    else if (code >= 90 && code <= 97) next.fg = color(code - 90 + 8)
    else if (code >= 100 && code <= 107) next.bg = color(code - 100 + 8)
    else if (code === 39) delete next.fg
    else if (code === 49) delete next.bg
    else if (code === 38 || code === 48) {
      const channel = code === 38 ? 'fg' : 'bg'
      if (values[i + 1] === 5 && i + 2 < values.length) {
        const parsed = color(values[i + 2])
        if (parsed) next[channel] = parsed
        i += 2
      } else if (values[i + 1] === 2 && i + 4 < values.length) {
        const channels = values.slice(i + 2, i + 5)
        if (channels.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
          next[channel] = { kind: 'rgb', r: channels[0], g: channels[1], b: channels[2] }
        }
        i += 4
      }
    }
  }
  state.style = next
}

function appendPlain(state: AnsiState, text: string): void {
  for (const char of text) {
    if (char === '\n') {
      state.rows.push([])
      state.cursor = 0
    } else if (char === '\r') state.cursor = 0
    else if (char === '\b') state.cursor = Math.max(0, state.cursor - 1)
    else {
      const row = state.rows[state.rows.length - 1]
      row[state.cursor] = { text: char, style: state.style }
      state.cursor++
    }
  }
}

/**
 * `CSI K`: erase in the current row — from the cursor to the end (0, the
 * default), from the start through the cursor (1), or all of it (2) — the way
 * a progress line clears itself after `\r`. The cursor does not move; the
 * cells before it that were erased read as spaces, so a row never has a hole.
 */
function eraseInLine(state: AnsiState, params: string): void {
  const row = state.rows[state.rows.length - 1]
  const mode = params === '' ? 0 : Number(params)
  if (mode === 0) {
    if (row.length > state.cursor) row.length = state.cursor
  } else if (mode === 1 || mode === 2) {
    const blank = Math.min(row.length, mode === 1 ? state.cursor + 1 : row.length)
    for (let index = 0; index < blank; index++) row[index] = { text: ' ', style: {} }
    if (mode === 2 && row.length > state.cursor) row.length = state.cursor
  }
}

function sameStyle(a: Cell['style'], b: Cell['style']): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike &&
    JSON.stringify(a.fg) === JSON.stringify(b.fg) &&
    JSON.stringify(a.bg) === JSON.stringify(b.bg)
  )
}

function toLines(state: AnsiState): AnsiLine[] {
  return state.rows.map((row) => {
    const line: AnsiLine = []
    for (const cell of row) {
      const last = line.at(-1)
      if (last && sameStyle(last, cell.style)) last.text += cell.text
      else line.push({ text: cell.text, ...cell.style })
    }
    return line
  })
}

function createState(): AnsiState {
  return { rows: [[]], cursor: 0, style: {}, pending: '', consumed: 0 }
}

function consumeEscape(state: AnsiState, char: string): boolean {
  state.pending += char
  // CAN and SUB abort a sequence wherever they land in it, and what follows is
  // text again; read as part of an OSC, a cancelled title hid all the rest.
  if (char === '\x18' || char === '\x1a') {
    state.pending = ''
    state.escapeKind = undefined
    state.oscEscape = false
    return true
  }
  if (state.escapeKind === 'start') {
    if (char === '[' || char === ']') {
      state.escapeKind = char === '[' ? 'csi' : 'osc'
      state.oscEscape = false
      return false
    }
    // Intermediate bytes (`ESC ( B` selects a character set) run until a
    // final byte; ending the escape at the first one printed that final "B".
    if (char >= ' ' && char <= '/') {
      state.escapeKind = 'intermediate'
      return false
    }
    state.pending = ''
    state.escapeKind = undefined
    return true
  }
  if (state.escapeKind === 'intermediate') {
    if (char >= ' ' && char <= '/') return false
    state.pending = ''
    state.escapeKind = undefined
    return true
  }
  if (state.escapeKind === 'csi') {
    const final = char.charCodeAt(0)
    if (final >= 0x40 && final <= 0x7e) {
      if (char === 'm') updateStyle(state, state.pending.slice(2, -1))
      else if (char === 'K') eraseInLine(state, state.pending.slice(2, -1))
      state.pending = ''
      state.escapeKind = undefined
      return true
    }
    return false
  }
  if (state.escapeKind === 'osc') {
    // Inspect only the new character: indexing/endsWith on the growing rope
    // flattens it every byte and makes an unterminated OSC quadratic.
    if (char === '\x07' || (state.oscEscape && char === '\\')) {
      state.pending = ''
      state.escapeKind = undefined
      state.oscEscape = false
      return true
    }
    if (state.oscEscape) {
      // An ESC that is not the `ESC \\` terminator cuts the OSC short and
      // starts the next escape, as a terminal reads it, rather than swallowing
      // everything after it into an OSC that never ends.
      state.pending = '\x1b'
      state.escapeKind = 'start'
      state.oscEscape = false
      return consumeEscape(state, char)
    }
    state.oscEscape = char === '\x1b'
    return false
  }
  state.pending = ''
  return true
}

function consume(state: AnsiState, chunk: string): void {
  const remaining = Math.max(0, INPUT_CAP - state.consumed)
  const parsed = chunk.slice(0, remaining)
  state.consumed += parsed.length
  for (const char of parsed) {
    if (state.pending) {
      consumeEscape(state, char)
    } else if (char === '\x1b') {
      state.pending = char
      state.escapeKind = 'start'
    } else {
      appendPlain(state, char)
    }
  }
  if (parsed.length < chunk.length) {
    if (state.pending) {
      appendPlain(state, state.pending)
      state.pending = ''
      state.escapeKind = undefined
      state.oscEscape = false
    }
    appendPlain(state, chunk.slice(parsed.length))
  }
}

export function parseAnsi(text: string): AnsiLine[]
export function parseAnsi(text: string, state: AnsiState): { lines: AnsiLine[]; state: AnsiState }
export function parseAnsi(text: string, state?: AnsiState): AnsiLine[] | { lines: AnsiLine[]; state: AnsiState } {
  const next = state ?? createState()
  consume(next, text)
  const lines = toLines(next)
  return state ? { lines, state: next } : lines
}

export function createAnsiState(): AnsiState {
  return createState()
}

/**
 * Terminal output as the words it leaves on screen: colour, cursor and OSC
 * escapes gone, and a line a progress bar redrew with `\r` as it ended up.
 * For output shown as plain text (a CLI's install or update log), where the
 * escapes would otherwise print as `[32m` and the bar as every frame of it.
 */
export function ansiPlainText(text: string): string {
  return parseAnsi(text)
    .map((line) => line.map((span) => span.text).join(''))
    .join('\n')
}

/**
 * {@link ansiPlainText} for a log that grows while it is shown (an install or
 * update streaming in): each call parses only what was appended since the
 * last, and reads back only the row still being written, rather than parsing
 * the whole log again for every chunk. A text that does not continue the last
 * one (a new run) is read from its start.
 */
export function createAnsiPlainTextReader(): (text: string) => string {
  let source = ''
  let state = createState()
  // The rows no later character can change (every one before the cursor's),
  // each with its newline.
  let finished = ''
  let finishedRows = 0
  const rowText = (row: Cell[]) => row.map((cell) => cell.text).join('')
  return (text) => {
    if (!text.startsWith(source)) {
      source = ''
      state = createState()
      finished = ''
      finishedRows = 0
    }
    consume(state, text.slice(source.length))
    source = text
    for (; finishedRows < state.rows.length - 1; finishedRows += 1)
      finished += `${rowText(state.rows[finishedRows]!)}\n`
    return finished + rowText(state.rows.at(-1) ?? [])
  }
}
