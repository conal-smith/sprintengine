import assert from 'node:assert/strict'
import { test } from 'vitest'

import { readTerminalOutputTail, unfinishedEscapeLength } from './terminal-output-tail'
import { TerminalReplayBuffer } from './terminal-replay-buffer'

const BUDGET = 1024 * 1024

function sessionWith(...chunks: string[]): { output: TerminalReplayBuffer; replaySnapshot?: string } {
  const output = new TerminalReplayBuffer()
  for (const chunk of chunks) output.append(chunk, BUDGET)
  return { output }
}

test('a read within the budget is everything retained, uncut, ending at the stream position', () => {
  const session = sessionWith('one\n', 'two\n')
  assert.deepEqual(readTerminalOutputTail(session, { maxBytes: 1024 }), {
    text: 'one\ntwo\n',
    cursor: 8,
    truncated: false,
  })
})

test('a read over the budget keeps the newest bytes, from a whole line, and says it was cut', () => {
  const session = sessionWith('first line\n', 'second line\n', 'third\n')
  const read = readTerminalOutputTail(session, { maxBytes: 14 })
  // The newest 14 bytes are "nd line\nthird\n"; the half line is dropped.
  assert.equal(read.text, 'third\n')
  assert.equal(read.truncated, true)
  assert.equal(read.cursor, 29)
})

test('a buffer whose head was evicted reports truncated even when the tail fits', () => {
  const output = new TerminalReplayBuffer()
  output.append('a'.repeat(100), 64)
  output.append('\nkept\n', 64)
  const read = readTerminalOutputTail({ output }, { maxBytes: 1024 })
  assert.equal(read.truncated, true)
  assert.equal(read.text, 'kept\n')
})

test('since a cursor, only what came after it is read', () => {
  const session = sessionWith('one\n', 'two\n')
  const first = readTerminalOutputTail(session, { maxBytes: 1024 })
  session.output.append('three\n', BUDGET)
  assert.deepEqual(readTerminalOutputTail(session, { maxBytes: 1024, since: first.cursor }), {
    text: 'three\n',
    cursor: 14,
    truncated: false,
  })
  assert.deepEqual(readTerminalOutputTail(session, { maxBytes: 1024, since: 14 }), {
    text: '',
    cursor: 14,
    truncated: false,
  })
})

test('a gap since the cursor larger than the budget returns its newest part and says so', () => {
  const session = sessionWith('start\n')
  const since = readTerminalOutputTail(session, { maxBytes: 1024 }).cursor
  session.output.append(`${'x'.repeat(50)}\nlast line\n`, BUDGET)
  const read = readTerminalOutputTail(session, { maxBytes: 20, since })
  assert.equal(read.text, 'last line\n')
  assert.equal(read.truncated, true)
})

test('a gap partly evicted since the cursor is read from what is retained, marked truncated', () => {
  const output = new TerminalReplayBuffer()
  output.append('early\n', 64)
  const since = readTerminalOutputTail({ output }, { maxBytes: 1024 }).cursor
  output.append(`${'y'.repeat(100)}\nrecent\n`, 64)
  const read = readTerminalOutputTail({ output }, { maxBytes: 1024, since })
  assert.equal(read.truncated, true)
  assert.equal(read.text, 'recent\n')
})

test('a cursor past the end of the stream reads as no cursor, not as nothing new forever', () => {
  const session = sessionWith('respawned\n')
  const read = readTerminalOutputTail(session, { maxBytes: 1024, since: 10_000 })
  assert.equal(read.text, 'respawned\n')
  assert.equal(read.cursor, 10)
})

test('a multi-byte character is never split, and the cursor counts UTF-16 units', () => {
  const session = sessionWith('ok ✓\n', '🚀 done\n')
  const read = readTerminalOutputTail(session, { maxBytes: 1024, since: 5 })
  assert.equal(read.text, '🚀 done\n')
  assert.equal(read.cursor, 'ok ✓\n🚀 done\n'.length)
})

test('a released stream answers from the rendered screen, and nothing once the reader has seen its end', () => {
  const output = new TerminalReplayBuffer()
  output.append('raw stream\n', BUDGET)
  const end = output.appendedUnits
  output.clear()
  const session = { output, replaySnapshot: 'the last screen\n' }
  assert.deepEqual(readTerminalOutputTail(session, { maxBytes: 1024 }), {
    text: 'the last screen\n',
    cursor: end,
    truncated: false,
  })
  assert.equal(readTerminalOutputTail(session, { maxBytes: 1024, since: 3 }).text, 'the last screen\n')
  assert.deepEqual(readTerminalOutputTail(session, { maxBytes: 1024, since: end }), {
    text: '',
    cursor: end,
    truncated: false,
  })
})

test('a rendered screen over the budget keeps its newest lines', () => {
  const output = new TerminalReplayBuffer()
  const read = readTerminalOutputTail({ output, replaySnapshot: 'top\nmiddle\nbottom\n' }, { maxBytes: 10 })
  assert.equal(read.text, 'bottom\n')
  assert.equal(read.truncated, true)
})

test('a read ending inside an escape sequence holds it back for the next read', () => {
  const session = sessionWith('ready\n\x1b[3')
  const first = readTerminalOutputTail(session, { maxBytes: 1024 })
  assert.equal(first.text, 'ready\n')
  assert.equal(first.cursor, 6)
  session.output.append('1merror\x1b[0m\n', BUDGET)
  const next = readTerminalOutputTail(session, { maxBytes: 1024, since: first.cursor })
  assert.equal(next.text, '\x1b[31merror\x1b[0m\n')
})

test('an unfinished escape is told apart from a finished one of every kind', () => {
  assert.equal(unfinishedEscapeLength('plain'), 0)
  assert.equal(unfinishedEscapeLength('a\x1b'), 1)
  assert.equal(unfinishedEscapeLength('a\x1b[1;3'), 5)
  assert.equal(unfinishedEscapeLength('a\x1b[1;31m'), 0)
  assert.equal(unfinishedEscapeLength('a\x1b]0;title'), 9)
  assert.equal(unfinishedEscapeLength('a\x1b]0;title\x07'), 0)
  assert.equal(unfinishedEscapeLength('a\x1b]8;;https://example.com\x1b\\link'), 0)
  assert.equal(unfinishedEscapeLength('a\x1b('), 2)
  assert.equal(unfinishedEscapeLength('a\x1b(B'), 0)
  assert.equal(unfinishedEscapeLength('a\x1bM'), 0)
  // Too far back to be a sequence still being written.
  assert.equal(unfinishedEscapeLength(`\x1b[${'1'.repeat(5_000)}`), 0)
})
