import assert from 'node:assert/strict'

import { test } from 'vitest'

import { keepInsightLineBreaks } from './markdownInsight'

const RULE = '─────────────────────────────────────────────────'

test('the lines of an Insight block keep their breaks, and its closing rule stands alone', () => {
  const reply = [
    'Done.',
    '',
    '`★ Insight ─────────────────────────────────────`',
    'The cache keys on the path',
    'so a rename misses it',
    `\`${RULE}\``,
    '',
    'Next steps follow.',
  ].join('\n')
  assert.equal(
    keepInsightLineBreaks(reply),
    [
      'Done.',
      '',
      '`★ Insight ─────────────────────────────────────`  ',
      'The cache keys on the path  ',
      'so a rename misses it',
      '',
      `\`${RULE}\``,
      '',
      'Next steps follow.',
    ].join('\n'),
  )
})

test('a bulleted Insight keeps its closing rule out of the last bullet', () => {
  const reply = ['★ Insight ─────', '- First point', '- Second point', RULE].join('\n')
  assert.equal(
    keepInsightLineBreaks(reply),
    ['★ Insight ─────  ', '- First point  ', '- Second point', '', RULE].join('\n'),
  )
})

test('a reply without one, or with one quoted in code, is left as written', () => {
  const plain = 'A normal\nmarkdown paragraph\n---'
  assert.equal(keepInsightLineBreaks(plain), plain)
  const fenced = ['```text', '★ Insight ─────', 'one', 'two', RULE, '```'].join('\n')
  assert.equal(keepInsightLineBreaks(fenced), fenced)
  const mentioned = 'The style writes a ★ Insight block\nlike this one.'
  assert.equal(keepInsightLineBreaks(mentioned), mentioned)
})

test('a block still streaming in keeps its breaks so far', () => {
  assert.equal(keepInsightLineBreaks('`★ Insight ───`\nfirst\nsec'), '`★ Insight ───`  \nfirst  \nsec')
})
