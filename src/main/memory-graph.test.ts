import { expect, test } from 'vitest'

import { parseMarkdownLinks } from './memory-graph'

// What the scan replaced, kept as the reference for what it finds.
function regexLinks(content: string): string[] {
  const links: string[] = []
  for (const match of content.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    links.push(raw.split(/\s+["'][^"']*["']\s*$/u)[0]?.trim() ?? raw)
  }
  return links
}

test('links and images are found as the regex found them', () => {
  const notes = [
    'See [the plan](plans/q4.md) and ![logo](brand/logo.png).',
    '[titled](notes/a.md "A title") then [spaced]( notes/b.md )',
    '[empty]() [blank]( ) [no paren] (x) [a [nested](inner.md) label]',
    '[[wikilink]] and [first](one.md)[second](two.md)',
    '[multi\nline](across.md) and [unclosed](never',
    '] stray [ brackets ( and ) then [last](last.md)',
    '',
  ]
  for (const note of notes) expect(parseMarkdownLinks(note)).toEqual(regexLinks(note))
  expect(parseMarkdownLinks(notes[0]!)).toEqual(['plans/q4.md', 'brand/logo.png'])
  expect(parseMarkdownLinks(notes[1]!)).toEqual(['notes/a.md', 'notes/b.md'])
})

test('a note of brackets that never close is read in one pass', () => {
  const log = '\x1b[32m PASS \x1b[39m src/a.test.ts\n'.repeat(20_000)
  const unclosed = '[unfinished\n'.repeat(60_000)
  const noParen = '[x](https://example.com/'.repeat(20_000)
  const started = performance.now()
  expect(parseMarkdownLinks(log)).toEqual([])
  expect(parseMarkdownLinks(unclosed)).toEqual([])
  expect(parseMarkdownLinks(noParen)).toEqual([])
  expect(performance.now() - started).toBeLessThan(1_000)
})
