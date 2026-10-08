import { expect, test } from 'vitest'

import { DIFF_TO_CHAT_MAX_CHARS } from '../../../../shared/ipc/window'
import { diffSelectionQuote, diffSelectionReference } from './diffToChat'

const selection = {
  path: 'src/health.ts',
  side: 'modified' as const,
  startLine: 12,
  endLine: 14,
  code: 'export async function health() {\n  await pool.ready()\n}\n',
  language: 'typescript',
}

test('the reference is the path and its lines, one line written once', () => {
  expect(diffSelectionReference(selection)).toBe('src/health.ts:L12-L14')
  expect(diffSelectionReference({ ...selection, endLine: 12 })).toBe('src/health.ts:L12')
})

test('the lines go as a quote: where they are, then the code fenced, then the note as the person wrote it', () => {
  expect(diffSelectionQuote(selection, '  Why wait here?  ')).toEqual({
    kind: 'quote',
    text: [
      '> `src/health.ts:L12-L14`',
      '> ```typescript',
      '> export async function health() {',
      '>   await pool.ready()',
      '> }',
      '> ```',
      '',
      'Why wait here?',
    ].join('\n'),
  })
})

test('lines from the old side say so, and no note leaves the quote alone', () => {
  const quote = diffSelectionQuote({ ...selection, side: 'original', code: 'pool.query()' })
  expect(quote.kind === 'quote' && quote.text).toBe(
    ['> `src/health.ts:L12-L14` (before the change)', '> ```typescript', '> pool.query()', '> ```'].join('\n'),
  )
})

test('code holding a fence gets a longer one, so it cannot close the quote early', () => {
  const quote = diffSelectionQuote({ ...selection, language: 'markdown', code: 'Run:\n```sh\nnpm test\n```' })
  expect(quote.kind === 'quote' && quote.text.split('\n')[1]).toBe('> ````markdown')
  expect(quote.kind === 'quote' && quote.text.split('\n').at(-1)).toBe('> ````')
})

test('a selection too long to carry is refused with its length, never cut short', () => {
  const long = diffSelectionQuote({ ...selection, code: 'x'.repeat(DIFF_TO_CHAT_MAX_CHARS) })
  expect(long.kind).toBe('too-long')
})
