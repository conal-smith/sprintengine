import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './markdown'
import { repairMarkdownFileLinks } from './markdownFileLinks'

const CLOSED: Array<[string, string, string]> = [
  [
    'a relative path',
    'See [CONTRIBUTING.md](<CONTRIBUTING.md) for details.',
    'See [CONTRIBUTING.md](<CONTRIBUTING.md>) for details.',
  ],
  ['a path with spaces', '[notes](<docs/release notes.md)', '[notes](<docs/release notes.md>)'],
  ['an absolute path', '[app](</Users/dev/acme/src/app.ts)', '[app](</Users/dev/acme/src/app.ts>)'],
  ['a Windows path', '[app](<C:\\acme\\src\\app.ts)', '[app](<C:\\acme\\src\\app.ts>)'],
  ['a path with a line suffix', '[app](<src/app.ts:12)', '[app](<src/app.ts:12>)'],
  ['each link on a line', '[a](<a.md) and [b](<b.md)', '[a](<a.md>) and [b](<b.md>)'],
  ['a link inside emphasis', '**[a](<a.md)**', '**[a](<a.md>)**'],
  ['a label with brackets of its own', '[see [a]](<a.md)', '[see [a]](<a.md>)'],
  ['a line after a closed fence', '```\ncode\n```\n[a](<a.md)', '```\ncode\n```\n[a](<a.md>)'],
]

for (const [name, input, expected] of CLOSED) {
  test(`closes an unclosed file destination: ${name}`, () => {
    expect(repairMarkdownFileLinks(input)).toBe(expected)
  })
}

const UNTOUCHED: Array<[string, string]> = [
  ['a link already closed', '[a](<a.md>) and [b](b.md)'],
  ['a web address', '[docs](<https://example.com/docs)'],
  ['a mail address', '[mail](<mailto:dev@example.com)'],
  ['a fragment', '[top](<#top)'],
  ['an image', '![shot](<shots/a.png)'],
  ['escaped brackets', '\\[a\\](<a.md)'],
  ['an escaped closing bracket', '[a\\](<a.md)'],
  ['a code span', 'write `[a](<a.md)` to link'],
  ['a code span of two backticks', 'write ``[a](<a.md)`` to link'],
  ['a fenced block', '```md\n[a](<a.md)\n```'],
  ['a tilde fence', '~~~\n[a](<a.md)\n~~~'],
  ['no closing parenthesis on the line', '[a](<a.md\nand more)'],
  ['an empty destination', '[a](<)'],
  ['raw HTML in the destination', '[a](<b>bold</b>)'],
  ['text with no link at all', 'nothing to see (<here)'],
]

for (const [name, input] of UNTOUCHED) {
  test(`leaves the text as written: ${name}`, () => {
    expect(repairMarkdownFileLinks(input)).toBe(input)
  })
}

test('an agent reply links the file; a document renders the brackets as written', () => {
  const text = 'See [CONTRIBUTING.md](<CONTRIBUTING.md) for details.'
  const links: string[] = []
  const renderLink = (href: string, label: React.ReactNode) => {
    links.push(href)
    return <a href={href}>{label}</a>
  }
  const reply = renderToStaticMarkup(<>{renderMarkdown(text, { repairFileLinks: true, renderLink })}</>)
  expect(links).toEqual(['CONTRIBUTING.md'])
  expect(reply).toContain('<a href="CONTRIBUTING.md">CONTRIBUTING.md</a>')
  expect(reply).not.toContain('](')

  const document = renderToStaticMarkup(<>{renderMarkdown(text, { renderLink })}</>)
  expect(document).toContain('[CONTRIBUTING.md](&lt;CONTRIBUTING.md)')
})
