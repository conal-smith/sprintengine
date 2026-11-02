import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './markdown'

// The page a reply renders to, links drawn as plain anchors.
function html(text: string): string {
  return renderToStaticMarkup(<>{renderMarkdown(text, { renderLink: (href, label) => <a href={href}>{label}</a> })}</>)
}

test('a bare web address keeps its trailing underscores and tildes', () => {
  for (const url of [
    'https://x.com/name_',
    'http://example.com/name__',
    'https://example.com/name~',
    'https://example.com/a_~',
  ]) {
    for (const after of ['', '.', ',', ')']) {
      expect(html(`See ${url}${after} next`), url + after).toContain(`<a href="${url}">${url}</a>${after} next`)
    }
  }
  expect(html('See www.example.com/name_ next')).toContain(
    '<a href="http://www.example.com/name_">www.example.com/name_</a> next',
  )
  expect(html('https://x.com/a_ https://x.com/b_')).toContain(
    '<a href="https://x.com/a_">https://x.com/a_</a> <a href="https://x.com/b_">https://x.com/b_</a>',
  )
})

test('a link that is not bare reads as before', () => {
  expect(html('[test](https://x.com/a)_')).toContain('<a href="https://x.com/a">test</a>_')
  expect(html('<https://x.com/a>_')).toContain('<a href="https://x.com/a">https://x.com/a</a>_')
  expect(html('[https://x.com/a](https://x.com/a)_')).toContain('<a href="https://x.com/a">https://x.com/a</a>_')
  expect(html('`https://x.com/a_`')).toContain('<code')
  expect(html('`https://x.com/a_`')).not.toContain('<a ')
  // Emphasis around the address still closes on its underscore.
  expect(html('_https://x.com/a_')).toContain('<a href="https://x.com/a">https://x.com/a</a></em>')
  expect(html('https://x.com/a. _')).toContain('<a href="https://x.com/a">https://x.com/a</a>. _')
})
