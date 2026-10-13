import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './markdown'

// What a reply's link and image renderers are handed, as the conversation
// view wires them.
function destinations(text: string): string[] {
  const seen: string[] = []
  renderToStaticMarkup(
    <>
      {renderMarkdown(text, {
        renderLink: (href, label) => {
          seen.push(`link ${href}`)
          return <a href={href}>{label}</a>
        },
        renderImage: (src) => {
          seen.push(`image ${src}`)
          return null
        },
      })}
    </>,
  )
  return seen
}

test('a Windows path keeps the backslashes markdown would read as escapes', () => {
  expect(destinations('[a](C:\\Users\\me\\.claude\\s.json)')).toEqual(['link C:\\Users\\me\\.claude\\s.json'])
})

test('a Windows path in angle brackets reaches the link unencoded', () => {
  expect(destinations('[a](<C:\\Users\\me\\My Notes\\a.md>)')).toEqual(['link C:\\Users\\me\\My Notes\\a.md'])
})

test('an image path keeps its escaped dot and underscore', () => {
  expect(destinations('![i](C:\\x\\.cache\\_b\\p.png)')).toEqual(['image C:\\x\\.cache\\_b\\p.png'])
})

test('a UNC path in a reference definition is kept for the link that uses it', () => {
  expect(destinations('[u][r]\n\n[r]: \\\\server\\share\\.x\\a.md')).toEqual(['link \\\\server\\share\\.x\\a.md'])
})

test('a web address still reads its escapes as escapes', () => {
  expect(destinations('[w](https://e.com/a\\.b)')).toEqual(['link https://e.com/a.b'])
})

test('a path holding a character reference reads it as the character it names', () => {
  expect(destinations('[a](C:\\R&amp;D\\a.md)')).toEqual(['link C:\\R&D\\a.md'])
})

test('a relative path is unchanged', () => {
  expect(destinations('[a](docs/a\\_b.md)')).toEqual(['link docs/a_b.md'])
})
