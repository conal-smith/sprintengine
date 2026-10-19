import { expect, test } from 'vitest'
import { composerTokenAt, detectComposerTrigger, tokenOpensMessage } from './composerTrigger'

const cases: Array<[string, string | null, string?]> = [
  ['|', null],
  ['hello|', null],
  ['@|', 'mention', ''],
  ['@src|', 'mention', 'src'],
  [' @src|', 'mention', 'src'],
  ['hello @src|', 'mention', 'src'],
  ['hello\n@src|', 'mention', 'src'],
  ['\t@src|', 'mention', 'src'],
  ['dev@example.com|', null],
  ['hello dev@example.com|', null],
  ['x@|', null],
  ['word@src|', null],
  ['/|', 'slash', ''],
  ['/review|', 'slash', 'review'],
  [' /review|', 'slash', 'review'],
  ['word/review|', null],
  ['$|', 'skill', ''],
  ['$review|', 'skill', 'review'],
  [' $review|', 'skill', 'review'],
  ['word$review|', null],
  ['@src/app.ts|', 'mention', 'src/app.ts'],
  ['@README.md|', 'mention', 'README.md'],
  ['@café|', 'mention', 'café'],
  ['@日本語|', 'mention', '日本語'],
  ['🙂 @file|', 'mention', 'file'],
  ['🙂@file|', null],
  ['你好 @文件|', 'mention', '文件'],
  ['你好@文件|', null],
  ['@foo |', null],
  ['/review |', null],
  ['$review |', null],
  ['hello |@file', null],
  ['@fi|le', 'mention', 'fi'],
  ['one @fi|le two', 'mention', 'fi'],
  ['@|file', 'mention', ''],
  ['|@file', null],
  ['@@file|', null],
  ['//review|', null],
  ['$$review|', null],
  ['@$review|', null],
  ['\r\n@file|', 'mention', 'file'],
  ['\u00a0@file|', 'mention', 'file'],
  ['\u2003$review|', 'skill', 'review'],
  ['/@bad|', null],
  ['@a-b_c.test|', 'mention', 'a-b_c.test'],
  ['/plugin:review|', 'slash', 'plugin:review'],
  ['$scope:review|', 'skill', 'scope:review'],
  ['a@example.com |next', null],
]
test.each(cases)('composer trigger at %s', (marked, kind, query) => {
  const caret = marked.indexOf('|'),
    text = marked.replace('|', '')
  const result = detectComposerTrigger(text, caret)
  if (!kind) expect(result).toBeNull()
  else {
    expect(result).toMatchObject({ kind, query })
    expect(text[result!.range.start]).toMatch(/[/@$]/u)
  }
})
// `/` opens the command menu wherever a token can start: the start of the
// draft, the start of any line, or after whitespace, with the caret still in
// the name. Inside a word, a path or a URL it is the text's own character.
const commandCases: Array<[string, string | null]> = [
  // The start of the draft.
  ['/rev|', 'rev'],
  ['  /rev|', 'rev'],
  ['\n  /rev|', 'rev'],
  ['/rev|iew', 'rev'],
  // The start of a later line.
  ['first line\n/rev|', 'rev'],
  ['first line\n  /rev|', 'rev'],
  ['first line\r\n/rev|', 'rev'],
  ['a paragraph.\n\n/|', ''],
  // After whitespace, mid-line.
  ['please /review|', 'review'],
  ['some text /|', ''],
  ['x /plugin:review|', 'plugin:review'],
  ['first line\nplease /review|', 'review'],
  ['tab\t/rev|', 'rev'],
  ['one /rev|iew two', 'rev'],
  // A space after the name closes it, so arguments are typed as text.
  ['/review 12|', null],
  ['/review |', null],
  ['please /review |', null],
  // Inside a word.
  ['and/or|', null],
  ['word/|', null],
  ['a/b|', null],
  // A path.
  ['src/foo|', null],
  ['see src/foo|', null],
  ['/src/foo|', null],
  ['see /src/foo|', null],
  ['/Users/dev/app|', null],
  ['open ./scripts|', null],
  ['dev@example.com/x|', null],
  // A path with the caret moved back into it, before its second `/`.
  ['/et|c/hosts', null],
  ['cat /et|c/hosts', null],
  ['/|etc/hosts', null],
  // A URL.
  ['https://|', null],
  ['see https://example.com/docs|', null],
  ['see https:/|', null],
  ['//review|', null],
  ['text //|', null],
]
test.each(commandCases)('command trigger at %j', (marked, query) => {
  const caret = marked.indexOf('|'),
    text = marked.replace('|', '')
  const result = detectComposerTrigger(text, caret)
  if (query === null) expect(result).toBeNull()
  else {
    expect(result).toMatchObject({ kind: 'slash', query })
    expect(text[result!.range.start]).toBe('/')
  }
})

test('a token opens the message only with nothing but blank space before it', () => {
  expect(tokenOpensMessage('/rev', 0)).toBe(true)
  expect(tokenOpensMessage('  \n /rev', 4)).toBe(true)
  expect(tokenOpensMessage('first line\n/rev', 11)).toBe(false)
  expect(tokenOpensMessage('please /rev', 7)).toBe(false)
})

test('a mid-message token spans just its own name, so a pick leaves the rest of the draft alone', () => {
  expect(detectComposerTrigger('intro text\n/rev more', 13)).toEqual({
    kind: 'slash',
    query: 'r',
    range: { start: 11, end: 15 },
  })
  expect(detectComposerTrigger('run /rev now', 8)).toEqual({ kind: 'slash', query: 'rev', range: { start: 4, end: 8 } })
})

test('a token reader for one marker ignores the others', () => {
  expect(composerTokenAt('hello $rev', 10, '/')).toBeNull()
  expect(composerTokenAt('hello $rev', 10, '$')).toEqual({ marker: '$', query: 'rev', range: { start: 6, end: 10 } })
  expect(composerTokenAt('hello\n/rev', 10, '/')).toEqual({ marker: '/', query: 'rev', range: { start: 6, end: 10 } })
  expect(composerTokenAt('src/rev', 7, '/')).toBeNull()
  expect(composerTokenAt('/rev', 4, '')).toBeNull()
})

test('the command token spans the whole name, so a pick replaces what the caret sits in', () => {
  expect(detectComposerTrigger('\n/rev', 3)).toEqual({ kind: 'slash', query: 'r', range: { start: 1, end: 5 } })
})

test('$ and @ still open anywhere after whitespace, including mid-line', () => {
  expect(detectComposerTrigger('please use $review', 18)).toMatchObject({ kind: 'skill', query: 'review' })
  expect(detectComposerTrigger('look at @src', 12)).toMatchObject({ kind: 'mention', query: 'src' })
})

test('mid-token replacement consumes the entire token and rejects invalid carets', () => {
  expect(detectComposerTrigger('one @file.ts two', 7)?.range).toEqual({ start: 4, end: 12 })
  expect(detectComposerTrigger('@file', -1)).toBeNull()
  expect(detectComposerTrigger('@file', 8)).toBeNull()
  expect(detectComposerTrigger('@file', 1.5)).toBeNull()
})
