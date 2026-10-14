import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createParagraphHold } from './markdownSegments'

/** What a reply shows, a paragraph at a time, once `source` has streamed in. */
function shown(source: string): string {
  return createParagraphHold()(source)
}

/** What shows at every point of `source` streaming in, one character at a time, through one hold. */
function stream(source: string): string[] {
  const hold = createParagraphHold()
  const seen: string[] = []
  for (let length = 0; length <= source.length; length += 1) {
    const text = hold(source.slice(0, length))
    if (text !== seen.at(-1)) seen.push(text)
  }
  return seen
}

test('nothing shows until the first paragraph ends', () => {
  assert.equal(shown(''), '')
  assert.equal(shown('Hello'), '')
  assert.equal(shown('Hello, world.\n'), '')
  assert.equal(shown('Hello, world.\nStill the same paragraph.\n'), '')
})

test('a blank line ends a paragraph', () => {
  assert.equal(shown('One.\n\nTwo is still'), 'One.\n\n')
  assert.equal(shown('One.\n\nTwo.\n\nThree'), 'One.\n\nTwo.\n\n')
  assert.equal(shown('One.\n \t\nTwo'), 'One.\n \t\n')
})

test('a blank line before anything else is no boundary', () => {
  assert.equal(shown('\n\nOne'), '')
})

test('a blank line inside an open code fence is code, not a boundary', () => {
  assert.equal(shown('Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n'), 'Intro.\n\n')
  assert.equal(shown('~~~\na\n\nb\n'), '')
})

test('a closed code fence ends a block at its closing line', () => {
  assert.equal(shown('```ts\nconst a = 1\n```\nafter'), '```ts\nconst a = 1\n```\n')
  assert.equal(shown('~~~~\na\n~~~~~\n'), '~~~~\na\n~~~~~\n')
})

test('a fence closes only on its own character, at least as long, with nothing after it', () => {
  assert.equal(shown('````\na\n```\n\nb\n'), '')
  assert.equal(shown('```\na\n~~~\n\nb\n'), '')
  assert.equal(shown('```\na\n```js\n\nb\n'), '')
  assert.equal(shown('```\na\n```   \nb'), '```\na\n```   \n')
})

test('a fence in a list item opens and closes at its own indentation', () => {
  const source = '- step:\n\n  ```sh\n  npm test\n\n  npm run lint\n  ```\nafter'
  assert.equal(shown(source), '- step:\n\n  ```sh\n  npm test\n\n  npm run lint\n  ```\n')
})

test('a backtick line with a backtick after it is a code span, not a fence', () => {
  assert.equal(shown('```a` b\n\nnext'), '```a` b\n\n')
})

test('a fence still being written holds everything after its opener, however long', () => {
  const source = `Intro.\n\n\`\`\`\n${'line\n\n'.repeat(50)}`
  assert.equal(shown(source), 'Intro.\n\n')
})

test('a list item starts a block, so a tight list lands an item at a time', () => {
  assert.equal(shown('Steps:\n- one\n- two\n- thr'), 'Steps:\n- one\n- two\n')
  assert.equal(shown('1. one\n2. two'), '1. one\n')
  assert.equal(shown('1) one\n2) two'), '1) one\n')
  assert.equal(shown('- a\n  - nested\n'), '- a\n')
})

test('a list marker counts once the space after it is in, on the line still streaming', () => {
  assert.equal(shown('Steps:\n-'), '')
  assert.equal(shown('Steps:\n12.'), '')
  assert.equal(shown('Steps:\n- '), 'Steps:\n')
  assert.equal(shown('Steps:\n12. '), 'Steps:\n')
  // Not a marker at all: a negative number, a thematic break, emphasis.
  assert.equal(shown('Steps:\n-5 degrees\n'), '')
  assert.equal(shown('Steps:\n---\n'), '')
  assert.equal(shown('Steps:\n*stress*\n'), '')
})

test('a heading at the margin ends the block above it with no blank line between', () => {
  assert.equal(shown('Intro.\n# Title\nBody'), 'Intro.\n')
  assert.equal(shown('Intro.\n   # Indented title\n'), '')
})

test('a heading is held until a line of content follows it', () => {
  assert.equal(shown('Intro.\n\n## Title\n'), 'Intro.\n\n')
  assert.equal(shown('Intro.\n\n## Title\n\n'), 'Intro.\n\n')
  assert.equal(shown('Intro.\n\n## Title\n\nFirst line.\n\n'), 'Intro.\n\n## Title\n\nFirst line.\n\n')
})

test('a heading held over a list lands with its first item', () => {
  assert.equal(shown('## Steps\n- one\n- two'), '## Steps\n- one\n')
})

test('a heading straight after another holds them both until content follows', () => {
  assert.equal(shown('# Title\n## Subtitle\n\n'), '')
  assert.equal(shown('# Title\n## Subtitle\n\nText.\n\n'), '# Title\n## Subtitle\n\nText.\n\n')
})

test('a line of bold text alone is a title, and held like a heading', () => {
  assert.equal(shown('Intro.\n\n**Next steps:**\n\n'), 'Intro.\n\n')
  assert.equal(shown('Intro.\n\n**Next steps:**\n- one\n- two'), 'Intro.\n\n**Next steps:**\n- one\n')
  // Bold that starts a sentence is the sentence, not a title.
  assert.equal(shown('**Note** that it works.\n\n'), '**Note** that it works.\n\n')
})

test('a code fence after a heading lands with it once it closes', () => {
  assert.equal(shown('## Example\n```\ncode\n```\n'), '## Example\n```\ncode\n```\n')
})

test('a blank line inside display math is TeX, not a boundary', () => {
  assert.equal(shown('Intro.\n\n$$\na\n\nb\n'), 'Intro.\n\n')
  assert.equal(shown('Intro.\n\n$$\na\n\nb\n$$\n\nafter'), 'Intro.\n\n$$\na\n\nb\n$$\n\n')
  assert.equal(shown('\\[\na\n\nb\n'), '')
  assert.equal(shown('\\[ x \\]\n\nafter'), '\\[ x \\]\n\n')
})

test('CRLF line endings read as LF ones', () => {
  assert.equal(shown('One.\r\n\r\nTwo'), 'One.\r\n\r\n')
  assert.equal(shown('```\r\na\r\n\r\nb\r\n```\r\nafter'), '```\r\na\r\n\r\nb\r\n```\r\n')
  assert.equal(shown('Intro.\r\n\r\n## Title\r\n\r\n'), 'Intro.\r\n\r\n')
  assert.equal(shown('Steps:\r\n- one\r\n- two'), 'Steps:\r\n- one\r\n')
})

test('streamed a character at a time, it shows the same as each prefix read whole', () => {
  const source =
    'Intro with **bold**.\n\n## Plan\n\n1. first\n2. second\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n**Done:**\n- yes\n\nEnd.'
  const hold = createParagraphHold()
  for (let length = 0; length <= source.length; length += 1) {
    const prefix = source.slice(0, length)
    assert.equal(hold(prefix), shown(prefix), JSON.stringify(prefix))
  }
})

test('what shows only ever grows, a finished block at a time', () => {
  const steps = stream('One.\n\n- a\n- b\n\n```\nx\n```\nTwo.\n\nThree')
  assert.deepEqual(steps, [
    '',
    'One.\n\n',
    'One.\n\n- a\n',
    'One.\n\n- a\n- b\n\n',
    'One.\n\n- a\n- b\n\n```\nx\n```\n',
    'One.\n\n- a\n- b\n\n```\nx\n```\nTwo.\n\n',
  ])
})

test('while nothing new is finished, it answers with the very same string', () => {
  const hold = createParagraphHold()
  const first = hold('One.\n\nTwo is')
  assert.equal(hold('One.\n\nTwo is still'), first)
  assert.ok(Object.is(hold('One.\n\nTwo is still going'), first))
})

test('text that does not extend the last starts over', () => {
  const hold = createParagraphHold()
  assert.equal(hold('One.\n\nTwo.\n\n'), 'One.\n\nTwo.\n\n')
  assert.equal(hold('Other.\n\nmore'), 'Other.\n\n')
  assert.equal(hold('x'), '')
})
