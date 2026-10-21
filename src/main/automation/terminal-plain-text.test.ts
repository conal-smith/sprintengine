import assert from 'node:assert/strict'
import { test } from 'vitest'

import { terminalPlainText } from './terminal-plain-text'

const ROOMY = { maxLines: 100, maxChars: 10_000 }

test('colour, OSC and charset escapes are stripped to the words', () => {
  const raw =
    '\x1b]0;npm run dev\x07\x1b(B\x1b[1m\x1b[32m  VITE v5.0.0\x1b[39m\x1b[22m  ready\r\n' +
    '\x1b[31m✘ [ERROR]\x1b[0m Could not resolve "./missing"\r\n'
  assert.deepEqual(terminalPlainText(raw, ROOMY), {
    text: '  VITE v5.0.0  ready\n✘ [ERROR] Could not resolve "./missing"',
    lineCount: 2,
    truncated: false,
  })
})

test('a progress line redrawn with carriage returns reads as it ended', () => {
  const raw = 'building 10%\rbuilding 55%\rbuilding 100%\x1b[K\ndone\n'
  assert.equal(terminalPlainText(raw, ROOMY).text, 'building 100%\ndone')
})

test('control characters that paint nothing are dropped, tabs kept', () => {
  const raw = 'bell\x07 here\x00\x0b\x7f\u0085\tend\n'
  assert.equal(terminalPlainText(raw, ROOMY).text, 'bell here\tend')
})

test('trailing blanks come off every row and off the end', () => {
  assert.deepEqual(terminalPlainText('a   \nb\t\n\n\n', ROOMY), { text: 'a\nb', lineCount: 2, truncated: false })
})

test('only the newest lines are kept, and the answer says older ones were left out', () => {
  const raw = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')
  assert.deepEqual(terminalPlainText(raw, { maxLines: 3, maxChars: 10_000 }), {
    text: 'line 7\nline 8\nline 9',
    lineCount: 3,
    truncated: true,
  })
})

test('the character cap keeps whole newest lines', () => {
  const raw = `${'a'.repeat(40)}\n${'b'.repeat(10)}\n${'c'.repeat(10)}`
  assert.deepEqual(terminalPlainText(raw, { maxLines: 100, maxChars: 25 }), {
    text: `${'b'.repeat(10)}\n${'c'.repeat(10)}`,
    lineCount: 2,
    truncated: true,
  })
})

test('one line longer than the character cap keeps its newest characters', () => {
  const result = terminalPlainText('x'.repeat(100), { maxLines: 100, maxChars: 30 })
  assert.equal(result.text, 'x'.repeat(30))
  assert.equal(result.truncated, true)
  assert.equal(result.lineCount, 1)
})

test('nothing printed is an empty answer with no lines', () => {
  assert.deepEqual(terminalPlainText('', ROOMY), { text: '', lineCount: 0, truncated: false })
  assert.deepEqual(terminalPlainText('\x1b[2J\x1b[H', ROOMY), { text: '', lineCount: 0, truncated: false })
})
