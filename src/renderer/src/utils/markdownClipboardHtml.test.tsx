// @vitest-environment jsdom
import { expect, test } from 'vitest'

import { markdownClipboardHtml } from './markdownClipboardHtml'
import { PASTE_STYLES } from './pasteStyles'

// The HTML a paste would receive, as a document to query.
function pasted(markdown: string, options?: Parameters<typeof markdownClipboardHtml>[1]): Document {
  return new DOMParser().parseFromString(markdownClipboardHtml(markdown, options), 'text/html')
}

const REPLY = [
  '## Findings',
  '',
  '**1. Mistakes.** Each booking is *checked* twice.',
  '',
  '1. First',
  '2. Second',
  '',
  '- one',
  '- two',
  '',
  '| Step | Time |',
  '| --- | ---: |',
  '| build | 12s |',
  '',
  '```ts',
  'const a = 1 < 2',
  '```',
  '',
  'See [the guide](https://example.com/guide) and `npm test`.',
  '',
  'Energy is $$E = mc^2$$ here.',
  '',
  '$$',
  '\\frac{a}{b}',
  '$$',
].join('\n')

test('a reply pastes as bold, lists, headings, a table, code and a link', () => {
  const html = markdownClipboardHtml(REPLY)
  expect(html.startsWith('<meta charset="utf-8">')).toBe(true)
  const doc = pasted(REPLY)
  expect(doc.querySelector('h2')?.textContent).toBe('Findings')
  expect(doc.querySelector('strong')?.textContent).toBe('1. Mistakes.')
  expect(doc.querySelector('em')?.textContent).toBe('checked')
  expect([...doc.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual(['First', 'Second'])
  expect([...doc.querySelectorAll('ul > li')].map((item) => item.textContent)).toEqual(['one', 'two'])
  expect([...doc.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Step', 'Time'])
  expect(doc.querySelectorAll('td')[1].getAttribute('style')).toContain('text-align:right')
  expect(doc.querySelector('table')?.getAttribute('style')).toBe(PASTE_STYLES.table)
  const pre = doc.querySelector('pre')!
  expect(pre.textContent).toBe('const a = 1 < 2')
  expect(pre.getAttribute('style')).toContain('monospace')
  expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/guide')
  expect(doc.querySelector('p > code')?.textContent).toBe('npm test')
  expect(doc.querySelector('p > code')?.getAttribute('style')).toBe(PASTE_STYLES.code)
})

test('math pastes as the TeX it was written in, not a typeset drawing', () => {
  const html = markdownClipboardHtml(REPLY)
  expect(html).toContain('Energy is $$E = mc^2$$ here.')
  const blocks = [...pasted(REPLY).querySelectorAll('pre')]
  expect(blocks.map((block) => block.textContent)).toContain('\\frac{a}{b}')
  expect(html).not.toMatch(/katex|<math/u)
})

test('nothing of the app reaches the paste: no classes, custom properties, ids or colours on text', () => {
  const html = markdownClipboardHtml(
    `${REPLY}\n\n- [x] done\n\nA note[^1].\n\n[^1]: The footnote.\n\n> [!NOTE]\n> Mind it.`,
  )
  expect(html).not.toMatch(/class=|var\(--|\sid=|data-|aria-|(?:^|[;"])color:|background/u)
})

test('HTML and scripts written in the markdown stay the text they were', () => {
  const source = 'Hi <script>alert(1)</script> <b onclick="steal()">x</b>\n\n<img src=x onerror="alert(1)">'
  for (const options of [{}, { userText: true }]) {
    expect(markdownClipboardHtml(source, options)).not.toMatch(/<script|<b\b|<img/u)
    const doc = pasted(source, options)
    expect(doc.querySelector('script, b, img')).toBeNull()
    expect([...doc.querySelectorAll('*')].flatMap((node) => node.getAttributeNames())).not.toContain('onclick')
    expect(doc.body.textContent).toContain('<script>alert(1)</script>')
  }
})

test('a link that is not to the web or mail is its words', () => {
  const doc = pasted(
    'Open [a.ts](/Users/dev/app/a.ts:12), [run](javascript:alert(1)) or [jump](#findings); mail [us](mailto:dev@example.com).',
  )
  expect([...doc.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['mailto:dev@example.com'])
  expect(doc.body.textContent).toContain('Open a.ts, run or jump')
})

test('a task list keeps its boxes, an alert its title, and a footnote loses its way back', () => {
  const doc = pasted('- [x] Ship\n- [ ] Tell people\n\n> [!WARNING]\n> Mind the gap.\n\nSee[^1].\n\n[^1]: Why.')
  expect([...doc.querySelectorAll('li')].map((item) => item.textContent?.trim())).toEqual([
    '\u2611 Ship',
    '\u2610 Tell people',
    'Why.',
  ])
  expect(doc.querySelector('input')).toBeNull()
  expect(doc.querySelector('blockquote strong')?.textContent).toBe('Warning')
  expect(doc.querySelector('blockquote')?.textContent).toContain('Mind the gap.')
  expect(doc.body.textContent).not.toContain('↩')
})

test('a message is drawn as its bubble draws it: every newline a break, and a $$ only dollars', () => {
  const doc = pasted('first line\nsecond line\n\n**bold** costs $$5', { userText: true })
  expect(doc.querySelector('p')?.innerHTML.replace(/\n/gu, '')).toBe('first line<br>second line')
  expect(doc.querySelector('strong')?.textContent).toBe('bold')
  expect(doc.body.textContent).toContain('costs $$5')
})
