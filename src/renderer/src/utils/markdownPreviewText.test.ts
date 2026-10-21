import { expect, test } from 'vitest'
import { markdownPreviewText } from './markdownPreviewText'

const flat = (markdown: string): string => markdownPreviewText(markdown).replace(/\s+/g, ' ').trim()

test('a heading and emphasis read as their words', () => {
  expect(flat('## Operators\nUse **either** _option_ or ~~neither~~.')).toBe('Operators Use either option or neither.')
})

test('a link reads as its text, without its address', () => {
  expect(flat('See [the docs](https://example.com/docs) first.')).toBe('See the docs first.')
})

test('inline code keeps its text, markdown characters and all', () => {
  expect(flat('Match `**/*.ts` files')).toBe('Match **/*.ts files')
})

test('an image reads as its alt text', () => {
  expect(flat('Before ![the login screen](shot.png) after')).toBe('Before the login screen after')
})

test('list items and table cells are set apart by a space', () => {
  expect(flat('- [x] one\n- two\n\n| Name | Role |\n| --- | :---: |\n| `a \\| b` | either |')).toBe(
    'one two Name Role a | b either',
  )
})

test('a code block keeps its text, read as text', () => {
  expect(flat('Run this:\n\n```sh\n# install deps\nnpm ci\n```')).toBe('Run this: # install deps npm ci')
})

test('HTML keeps its text and loses its tags', () => {
  expect(flat('foo<br>bar\n\n<div>Critical <em>answer</em></div>')).toBe('foo bar Critical answer')
})

test('a word split by inline formatting stays one word', () => {
  expect(flat('**op**erators')).toBe('operators')
})

test('plain text reads as it is', () => {
  expect(flat('Done. The build passes.')).toBe('Done. The build passes.')
})

test('only the start of a long reply is read', () => {
  const long = `${'word '.repeat(400)}END`
  expect(markdownPreviewText(long)).not.toContain('END')
})
