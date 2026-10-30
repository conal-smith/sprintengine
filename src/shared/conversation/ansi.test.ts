import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  ansiPlainText,
  createAnsiPlainTextReader,
  createAnsiState,
  parseAnsi,
  type AnsiColor,
  type AnsiLine,
} from './ansi'

const fg = (index: number): AnsiColor => ({ kind: 'palette', index })
const rgb = (r: number, g: number, b: number): AnsiColor => ({ kind: 'rgb', r, g, b })

test('parses styling, controls, and terminal progress into spans', () => {
  const cases: Array<[string, AnsiLine[]]> = [
    ['', [[]]],
    ['plain', [[{ text: 'plain' }]]],
    ['a\nb', [[{ text: 'a' }], [{ text: 'b' }]]],
    ['a\r\nb', [[{ text: 'a' }], [{ text: 'b' }]]],
    ['a\n', [[{ text: 'a' }], []]],
    ['abc\rX', [[{ text: 'Xbc' }]]],
    ['abc\rXY', [[{ text: 'XYc' }]]],
    ['abc\bX', [[{ text: 'abX' }]]],
    ['\bX', [[{ text: 'X' }]]],
    ['\x1b[31mred', [[{ text: 'red', fg: fg(1) }]]],
    ['\x1b[32mgreen', [[{ text: 'green', fg: fg(2) }]]],
    ['\x1b[37mwhite', [[{ text: 'white', fg: fg(7) }]]],
    ['\x1b[90mgray', [[{ text: 'gray', fg: fg(8) }]]],
    ['\x1b[97mbright', [[{ text: 'bright', fg: fg(15) }]]],
    ['\x1b[41mred', [[{ text: 'red', bg: fg(1) }]]],
    ['\x1b[47mwhite', [[{ text: 'white', bg: fg(7) }]]],
    ['\x1b[100mgray', [[{ text: 'gray', bg: fg(8) }]]],
    ['\x1b[107mbright', [[{ text: 'bright', bg: fg(15) }]]],
    ['\x1b[38;5;196mred', [[{ text: 'red', fg: fg(196) }]]],
    ['\x1b[48;5;17mbg', [[{ text: 'bg', bg: fg(17) }]]],
    ['\x1b[38;2;12;34;56mrgb', [[{ text: 'rgb', fg: rgb(12, 34, 56) }]]],
    ['\x1b[48;2;2;4;6mbg', [[{ text: 'bg', bg: rgb(2, 4, 6) }]]],
    ['\x1b[1mbold', [[{ text: 'bold', bold: true }]]],
    ['\x1b[2mdim', [[{ text: 'dim', dim: true }]]],
    ['\x1b[3mitalic', [[{ text: 'italic', italic: true }]]],
    ['\x1b[4munder', [[{ text: 'under', underline: true }]]],
    ['\x1b[7minverse', [[{ text: 'inverse', inverse: true }]]],
    ['\x1b[9mstrike', [[{ text: 'strike', strike: true }]]],
    ['\x1b[1;31mhi', [[{ text: 'hi', bold: true, fg: fg(1) }]]],
    [
      '\x1b[1;2;3;4;7;9mx',
      [[{ text: 'x', bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true }]],
    ],
    ['\x1b[31mred\x1b[0mplain', [[{ text: 'red', fg: fg(1) }, { text: 'plain' }]]],
    ['\x1b[1mb\x1b[22mn', [[{ text: 'b', bold: true }, { text: 'n' }]]],
    ['\x1b[3mi\x1b[23mn', [[{ text: 'i', italic: true }, { text: 'n' }]]],
    ['\x1b[4mu\x1b[24mn', [[{ text: 'u', underline: true }, { text: 'n' }]]],
    ['\x1b[7mi\x1b[27mn', [[{ text: 'i', inverse: true }, { text: 'n' }]]],
    ['\x1b[9ms\x1b[29mn', [[{ text: 's', strike: true }, { text: 'n' }]]],
    ['\x1b[31mr\x1b[39mn', [[{ text: 'r', fg: fg(1) }, { text: 'n' }]]],
    ['\x1b[41mr\x1b[49mn', [[{ text: 'r', bg: fg(1) }, { text: 'n' }]]],
    ['\x1b[31;44mx', [[{ text: 'x', fg: fg(1), bg: fg(4) }]]],
    ['\x1b[2Ktext', [[{ text: 'text' }]]],
    ['\x1b[?25ltext', [[{ text: 'text' }]]],
    ['\x1b]0;title\x07text', [[{ text: 'text' }]]],
    ['\x1b]0;title\x1b\\text', [[{ text: 'text' }]]],
    ['\x1b]8;;https://example.com\x07link\x1b]8;;\x07', [[{ text: 'link' }]]],
    ['10%\r20%\r100%', [[{ text: '100%' }]]],
    ['\x1b[31mred\nnext', [[{ text: 'red', fg: fg(1) }], [{ text: 'next', fg: fg(1) }]]],
  ]
  assert.ok(cases.length >= 40)
  for (const [input, expected] of cases) assert.deepEqual(parseAnsi(input), expected, JSON.stringify(input))
})

test('keeps escape sequences and cursor state across chunks', () => {
  const state = createAnsiState()
  assert.deepEqual(parseAnsi('abc\x1b[38;2;1;', state).lines, [[{ text: 'abc' }]])
  assert.deepEqual(parseAnsi('2;3mX', state).lines, [[{ text: 'abc' }, { text: 'X', fg: rgb(1, 2, 3) }]])
  assert.deepEqual(parseAnsi('\rY', state).lines, [
    [{ text: 'Y', fg: rgb(1, 2, 3) }, { text: 'bc' }, { text: 'X', fg: rgb(1, 2, 3) }],
  ])
  const osc = createAnsiState()
  parseAnsi('\x1b]8;;https://example.com\x1b', osc)
  assert.deepEqual(parseAnsi('\\visible', osc).lines, [[{ text: 'visible' }]])
  const capped = createAnsiState()
  parseAnsi('x'.repeat(2 * 1024 * 1024), capped)
  assert.equal(parseAnsi('tail', capped).lines[0].at(-1)?.text.endsWith('tail'), true)
})

test('long incomplete OSC and CSI sequences remain linear and terminate across chunks', () => {
  const start = performance.now()
  for (const introducer of [']', '[']) {
    const state = createAnsiState()
    parseAnsi(`\x1b${introducer}`, state)
    for (let index = 0; index < 16; index++) parseAnsi('1'.repeat(64 * 1024), state)
    assert.equal(state.pending.length, 1024 * 1024 + 2)
    if (introducer === ']') {
      parseAnsi('\x1b', state)
      assert.deepEqual(parseAnsi('\\visible', state).lines, [[{ text: 'visible' }]])
    } else assert.deepEqual(parseAnsi('Kvisible', state).lines, [[{ text: 'visible' }]])
    assert.equal(state.pending, '')
  }
  assert.ok(performance.now() - start < 1500, 'bounded control parsing must not rescan the growing pending sequence')
  const bell = createAnsiState()
  parseAnsi('\x1b]', bell)
  parseAnsi('title\x1b', bell)
  assert.deepEqual(parseAnsi('\x07done', bell).lines, [[{ text: 'done' }]])
  const capped = createAnsiState()
  capped.consumed = 2 * 1024 * 1024 - 3
  assert.deepEqual(parseAnsi('\x1b]x\x1b[31m', capped).lines, [[{ text: '\x1b]x\x1b[31m' }]])
  assert.equal(capped.pending, '')
})

test('character set selections leave no stray final byte, even split across chunks', () => {
  // tput sgr0 emits `ESC ( B` after resetting colors.
  assert.deepEqual(parseAnsi('\x1b[31mred\x1b(B\x1b[m done'), [[{ text: 'red', fg: fg(1) }, { text: ' done' }]])
  assert.deepEqual(parseAnsi('a\x1b)0b\x1b#8c'), [[{ text: 'abc' }]])
  let state = createAnsiState()
  state = parseAnsi('x\x1b(', state).state
  assert.deepEqual(parseAnsi('By', state).lines, [[{ text: 'xy' }]])
})

test('plain text keeps the words a terminal would show and drops every escape', () => {
  assert.equal(
    ansiPlainText(
      '\x1b[32madded\x1b[39m 3 packages\n\x1b]8;;https://example.com\x07docs\x1b]8;;\x07\nfetching 10%\rfetching 100%\n',
    ),
    'added 3 packages\ndocs\nfetching 100%\n',
  )
})

test('a line that clears itself after a carriage return reads as what it was cleared to', () => {
  assert.equal(ansiPlainText('Downloading package 100%\r\x1b[KDone\n'), 'Done\n')
  assert.equal(ansiPlainText('resolving dependencies...\r\x1b[2Kok'), 'ok')
  assert.equal(ansiPlainText('abcdef\rxyz\x1b[1K'), '    ef')
})

test('an OSC cut short by another escape ends there instead of swallowing the rest', () => {
  assert.equal(ansiPlainText('\x1b]0;title\x1b[31mred text\x1b[0m'), 'red text')
})

test('CAN or SUB cancels a sequence, and the text after it is shown', () => {
  assert.equal(ansiPlainText('\x1b]0;title\x18after'), 'after')
  assert.equal(ansiPlainText('\x1b[12\x1aafter'), 'after')
})

test('a growing log read chunk by chunk reads as the whole of it parsed at once', () => {
  const log =
    '\x1b[32madded\x1b[39m 3 packages\n\x1b]8;;https://example.com\x07docs\x1b]8;;\x07\nfetching 10%\rfetching 100%\x1b[K\nbar \x1b[1mdone\x1b[0m'
  for (const size of [1, 2, 3, 5, 8, 13]) {
    const read = createAnsiPlainTextReader()
    let shown = ''
    for (let end = size; end < log.length + size; end += size) {
      const sofar = log.slice(0, end)
      shown = read(sofar)
      assert.equal(shown, ansiPlainText(sofar), `after ${end} characters, read ${size} at a time`)
    }
    assert.equal(shown, ansiPlainText(log))
  }
  // A new run is read from its start.
  const read = createAnsiPlainTextReader()
  read('first run\n')
  assert.equal(read('second'), 'second')
})
