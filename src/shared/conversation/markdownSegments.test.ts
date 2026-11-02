import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createMarkdownSplitter, splitMarkdownSegments } from './markdownSegments'

test('freezes after a closed top-level fence and its blank line', () => {
  const block = 'before\n\n```ts\nconst x = 1\n```\n\n'
  const cases: Array<[string, number]> = [
    ['', 0],
    ['hello', 0],
    ['```\nx\n```', 0],
    ['```\nx\n```\n', 0],
    ['```\nx\n```\n\n', 1],
    // `before` is a paragraph of its own, and freezes before the fence.
    [block, 2],
    [block + 'after', 2],
    [block + 'after\n', 2],
    [block + '```py\nx\n```\n\n', 3],
    ['~~~\na\n~~~\n\n', 1],
    ['~~~~~\na\n~~~~~\n\n', 1],
    ['````\na\n```\n\n', 0],
    ['~~~~\na\n~~~\n\n', 0],
    ['```\na\n~~~\n\n', 0],
    ['~~~\na\n```\n\n', 0],
    ['```js\na\n```\n\n', 1],
    ['```bad`info\na\n```\n\n', 0],
    ['  ```\na\n  ```\n\n', 0],
    ['> ```\n> a\n> ```\n\n', 0],
    ['- ```\n  a\n  ```\n\n', 0],
    ['```\na\n```\nnot blank\n', 0],
    ['```\na\n```\n \n', 1],
    ['```\na\n```\n\t\n', 1],
    ['```\na\n```\n\n```\nb\n```\n\n', 2],
    ['```\na\n```\n\n```\nb\n```\n', 1],
    ['```\na\n```\n\nmore\n\n', 1],
    ['```\na\n```\n\n[id]: /a', 0],
    ['```\na\n```\n\n[^note]: text', 0],
    ['```\na\n```\n\n\r', 0],
    ['\uFEFF```\na\n```\n\n', 0],
    ['<div>\n```\na\n```\n\n', 0],
    ['<!-- open\n```\na\n```\n\n', 0],
    ['<div>\n</div>\n```\na\n```\n\n', 1],
    ['<!-- closed -->\n```\na\n```\n\n', 1],
    // An indented fence still opens a code block: the unindented ``` after it
    // closes it, and the next ``` opens a block that is still unclosed.
    ['  ```\n```\nx\n```\n\n', 0],
    [' ~~~\n~~~\n\n', 0],
    // A line left of a list item's fence ends the item and the fence with it,
    // and what follows may open another: nothing after it is split.
    ['- a\n\n  ```\n  x\n\n```\n\nb', 0],
    ['- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb', 0],
    ['- a\n\n  ```\n  x\n  ```\n\nb', 1],
    // HTML inside inline code or a code block is text, not an open element.
    ['Use `<div>` here\n```\na\n```\n\n', 1],
    ['Use ``<div>`` here\n```\na\n```\n\n', 1],
    ['```html\n<div>\n```\n\n```\nb\n```\n\n', 2],
  ]
  assert.ok(cases.length >= 30)
  for (const [source, count] of cases) {
    const parts = splitMarkdownSegments(source)
    assert.equal(parts.frozen.length, count, source)
    assert.equal(parts.frozen.join('') + parts.tail, source, source)
  }
})

test('frozen segments retain their identity as ordinary text grows', () => {
  const source = 'before\n\n```ts\nx\n```\n\nafter\n\n~~~\ny\n~~~\n\ntail'
  let previous: string[] = []
  for (let i = 0; i <= source.length; i++) {
    const current = splitMarkdownSegments(source.slice(0, i)).frozen
    assert.deepEqual(current.slice(0, previous.length), previous)
    previous = current
  }
})

test('freezes before a line that starts a new block at the margin after a blank line', () => {
  const cases: Array<[string, string[]]> = [
    ['one\n\ntwo', ['one\n\n']],
    ['one\n\ntwo\n\nthree', ['one\n\n', 'two\n\n']],
    ['one\n\n\ntwo', ['one\n\n\n']],
    ['# Title\n\nBody', ['# Title\n\n']],
    ['one\n\n> quote', ['one\n\n']],
    ['one\n\n| a | b |\n| - | - |', ['one\n\n']],
    ['one\n\n---', ['one\n\n']],
    ['one\n\n**bold**', ['one\n\n']],
    ['one\n\n-5 degrees', ['one\n\n']],
    ['one\n\n2024 was a year', ['one\n\n']],
    ['one\n\n12.5% more', ['one\n\n']],
    // Nothing after the blank line yet: where the next block starts is unknown.
    ['one\n\n', []],
    // A line after a blank line that may continue what came before never ends a segment:
    // a list marker (the list would turn loose), an indented line (a list item's
    // body, or indented code).
    ['- a\n\n- b', []],
    ['* a\n\n* b', []],
    ['+ a\n\n+ b', []],
    ['1. a\n\n2. b', []],
    ['1) a\n\n2) b', []],
    ['one\n\n- a', []],
    ['- a\n\n  more of a', []],
    ['    code\n\n    more code', []],
    ['one\n\n\tindented', []],
    ['- a\n\n  b\n\nafter the list', ['- a\n\n  b\n\n']],
    // A marker still streaming is not decided until the next character.
    ['one\n\n-', []],
    ['one\n\n12', []],
    ['one\n\n12.', []],
    // Inside a fence a blank line is text.
    ['```\na\n\nb', []],
    // Open raw HTML swallows what follows; closed, it does not.
    ['<div>\n\ntext', []],
    ['<div>\n</div>\n\ntext', ['<div>\n</div>\n\n']],
    ['<!-- note\n\ntext', []],
    ['<div\n\ntext', []],
    ['a <b and c\n\ntext', ['a <b and c\n\n']],
    ['<?php echo 1 ?>\n\ntext', []],
    // A definition anywhere keeps the message whole.
    ['one\n\ntwo\n\n[id]: /a', []],
    ['one\n\n[^1]: note', []],
  ]
  for (const [source, frozen] of cases) {
    const parts = splitMarkdownSegments(source)
    assert.deepEqual(parts.frozen, frozen, JSON.stringify(source))
    assert.equal(parts.frozen.join('') + parts.tail, source, JSON.stringify(source))
  }
})

test('a display math block is never split, however many blank lines its TeX holds', () => {
  const cases: Array<[string, string[]]> = [
    ['$$\na\n\nb\n$$', []],
    ['$$\na\n\nb', []],
    ['  $$\na\n\nb\n  $$', []],
    ['before\n\n$$\na\n\nb\n$$\n\nafter', ['before\n\n', '$$\na\n\nb\n$$\n\n']],
    ['\\[\na\n\nb\n\\]', []],
    ['\\[ a\n\nb \\]\n\nafter', ['\\[ a\n\nb \\]\n\n']],
    // A block of one line holds nothing open.
    ['\\[ E = mc^2 \\]\n\nafter', ['\\[ E = mc^2 \\]\n\n']],
    ['\\[1\\]\n\nafter', ['\\[1\\]\n\n']],
    // A `\]` with words after it is a sentence's bracket, and nothing was math:
    // what came before it stays in one segment, which reads the same, and the
    // splits resume after it.
    ['\\[ a\n\nb \\] and on\n\nafter', ['\\[ a\n\nb \\] and on\n\n']],
    // `$$$` and a `$$` with words beside it open nothing.
    ['$$$\n\nafter', ['$$$\n\n']],
    ['$$ x\n\nafter', ['$$ x\n\n']],
    // In a fence it is code; inside math a fence is TeX.
    ['```\n$$\n```\n\nafter', ['```\n$$\n```\n\n']],
    ['$$\n```\n\nb\n$$\n\nafter', ['$$\n```\n\nb\n$$\n\n']],
  ]
  for (const [source, frozen] of cases) {
    const parts = splitMarkdownSegments(source)
    assert.deepEqual(parts.frozen, frozen, JSON.stringify(source))
    assert.equal(parts.frozen.join('') + parts.tail, source, JSON.stringify(source))
  }
})

test('a splitter fed a growing message agrees with a fresh split at every length', () => {
  const messages = [
    'Intro paragraph.\n\n## Plan\n\n1. first\n2. second\n\n- loose\n\n- list\n\nAfter.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nEnd.',
    '<div>\nraw\n</div>\n\ntext <!-- c\n\n --> more\n\n    code\n\n    code\n\ndone\n\n12. twelve\n\n12 apples',
    'para\n\n[ref]: /x\n\nmore',
    'a\r\n\r\nb\n\nc',
    'Energy:\n\n$$\nE = mc^2\n\n\\text{and}\n$$\n\nThen\n\n\\[\nx\n\ny\n\\]\n\nDone.',
  ]
  for (const message of messages) {
    const split = createMarkdownSplitter()
    let previous: string[] = []
    for (let length = 0; length <= message.length; length++) {
      const prefix = message.slice(0, length)
      const streamed = split(prefix)
      assert.deepEqual(streamed, splitMarkdownSegments(prefix), JSON.stringify(prefix))
      // What froze stays frozen, unless the message stopped being splittable.
      if (streamed.frozen.length) assert.deepEqual(streamed.frozen.slice(0, previous.length), previous)
      previous = streamed.frozen
    }
  }
  // Text that does not extend what was seen starts over.
  const split = createMarkdownSplitter()
  split('one\n\ntwo')
  assert.deepEqual(split('uno\n\ndos'), { frozen: ['uno\n\n'], tail: 'dos' })
})

test('a streamed token reads only the text it added', () => {
  const split = createMarkdownSplitter()
  let text = ''
  const slice = String.prototype.slice
  let scanned = 0
  let rescan = 0
  String.prototype.slice = function (this: string, ...args: [number?, number?]) {
    const result = slice.apply(this, args)
    scanned += result.length
    return result
  }
  try {
    for (let index = 0; index < 2000; index++) {
      text += index % 40 === 39 ? 'word.\n\n' : 'word '
      rescan += text.length
      split(text)
    }
  } finally {
    String.prototype.slice = slice
  }
  // Each call slices out what was added, the last paragraph (the tail) and the
  // line still streaming: bounded by the paragraph, not by the whole message,
  // which a rescan on every token reads each time.
  assert.ok(scanned * 10 < rescan, `sliced ${scanned} characters where a rescan reads ${rescan}`)
})
