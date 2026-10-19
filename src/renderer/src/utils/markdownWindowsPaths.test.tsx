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

// The text a message reads as, with each code span marked.
function prose(text: string): string {
  const html = renderToStaticMarkup(<>{renderMarkdown(text, {})}</>)
  return html
    .replace(/<code[^>]*>/gu, '`')
    .replace(/<\/code>/gu, '`')
    .replace(/<[^>]+>/gu, '')
}

test('a drive path in prose keeps the backslashes markdown would read as escapes', () => {
  expect(prose(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`)).toBe(
    String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`,
  )
})

test('an escape past the end of a prose path still reads as an escape', () => {
  expect(prose(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  )
})

test('a path an agent already escaped keeps its doubled backslashes', () => {
  expect(prose(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`)
})

test('a path in a code span reads as before', () => {
  expect(prose('`C:\\me\\.t3` and C:\\me\\.t3')).toBe('`C:\\me\\.t3` and C:\\me\\.t3')
})
