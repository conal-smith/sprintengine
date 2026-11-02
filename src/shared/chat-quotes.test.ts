import { expect, test } from 'vitest'
import {
  QUOTES_PREAMBLE,
  collectQuotes,
  expandQuotesForAgent,
  locateQuote,
  nextQuoteNumber,
  parseQuoteHref,
  quoteAsMarkdown,
  quoteLabel,
  quoteToken,
  quotesToInlineText,
  quotesToLabels,
  clipKeepingQuotes,
  quotesToPlainText,
  quotesToReadableMarkdown,
  withQuoteComment,
  withoutQuote,
  type ChatQuote,
} from './chat-quotes'

const quote = (overrides: Partial<ChatQuote> = {}): ChatQuote => ({
  turnId: 'turn-7',
  n: 1,
  quote: 'Keep the cache warm.',
  exact: 'Keep the cache warm.',
  prefix: 'First, ',
  suffix: ' Then restart.',
  comment: '',
  ...overrides,
})

test('a token is a link labelled with its number whose address reads back as the same quote', () => {
  const token = quoteToken(quote({ n: 3, comment: 'Why warm?' }))
  expect(token.startsWith('[Quote 3](sprintengine-quote:?v=1&turn=turn-7&n=3&')).toBe(true)
  const [found] = collectQuotes(`About ${token} here`)
  expect(found).toMatchObject(quote({ n: 3, comment: 'Why warm?' }))
  expect(found?.from).toBe(6)
  expect(found?.to).toBe(6 + token.length)
})

test('awkward characters survive the round trip and never end the link early', () => {
  const awkward = quote({
    quote: 'Call `f(x)` then (maybe) g)\n\n> nested\n- ünïcødé 漢字 🙂 & = + % # ]',
    exact: 'Call f(x) then (maybe) g) nested ünïcødé 漢字 🙂',
    prefix: 'a ) b',
    suffix: '( c\td',
    comment: 'Line one\nLine two: “quoted” <tag> [x](y)',
  })
  const token = quoteToken(awkward)
  const address = token.slice(token.indexOf('](') + 2, -1)
  expect(address).not.toMatch(/[\s()]/u)
  const text = `Before ${token} after (a parenthesis) and ${quoteToken(quote({ n: 2 }))}.`
  const found = collectQuotes(text)
  expect(found).toHaveLength(2)
  expect(found[0]).toMatchObject(awkward)
  expect(found[1]?.n).toBe(2)
  expect(parseQuoteHref(address)).toEqual(awkward)
})

test('a link that only looks like a quote is left as text', () => {
  expect(collectQuotes('[Quote 1](sprintengine-quote:?v=1&n=1)')).toEqual([])
  expect(collectQuotes('[Quote 1](sprintengine-quote:?turn=t&n=0&quote=x)')).toEqual([])
  expect(collectQuotes('[site](https://example.com)')).toEqual([])
  expect(parseQuoteHref('https://example.com/?turn=t&n=1&quote=x')).toBeNull()
})

test('a new quote is numbered one past the highest in the sent messages and the draft', () => {
  expect(nextQuoteNumber([])).toBe(1)
  expect(nextQuoteNumber(['no quotes here'])).toBe(1)
  const sent = `${quoteToken(quote({ n: 1 }))} and ${quoteToken(quote({ n: 4 }))}`
  const draft = quoteToken(quote({ n: 2 }))
  expect(nextQuoteNumber([sent, draft])).toBe(5)
})

test('a comment is set, changed and cleared on the quote its token names and no other', () => {
  const two = quoteToken(quote({ n: 2 }))
  const text = `${quoteToken(quote({ n: 1 }))} and ${two} ok`
  const commented = withQuoteComment(text, two, '  Is this (still) true?  ')
  const [first, second] = collectQuotes(commented)
  expect(first?.comment).toBe('')
  expect(second?.comment).toBe('Is this (still) true?')
  expect(commented.endsWith(' ok')).toBe(true)
  expect(collectQuotes(withQuoteComment(commented, second!.token, ''))[1]?.comment).toBe('')
  expect(withQuoteComment(text, quoteToken(quote({ n: 9 })), 'nothing')).toBe(text)
})

test('of two quotes sharing a number, only the one the token names is changed', () => {
  const mine = quoteToken(quote({ n: 3, exact: 'Keep the cache', quote: 'Keep the cache' }))
  const pasted = quoteToken(quote({ n: 3, turnId: 'other', exact: 'Elsewhere', quote: 'Elsewhere' }))
  const text = `${pasted} ${mine} `
  const [kept, changed] = collectQuotes(withQuoteComment(text, mine, 'note'))
  expect(kept?.comment).toBe('')
  expect(changed?.comment).toBe('note')
  expect(withoutQuote(text, mine)).toBe(`${pasted} `)
})

test('removing a quote takes its token and the spaces it went in with', () => {
  const one = quoteToken(quote({ n: 1 }))
  const two = quoteToken(quote({ n: 2 }))
  const text = `Look ${one} here ${two}`
  expect(withoutQuote(text, one)).toBe(`Look here ${two}`)
  expect(withoutQuote(text, two)).toBe(`Look ${one} here `)
  expect(withoutQuote(text, two, { before: true, after: true })).toBe(`Look ${one} here`)
  expect(withoutQuote(`Look ${one} here`, one, {})).toBe('Look  here')
  expect(withoutQuote(text, quoteToken(quote({ n: 3 })))).toBe(text)
})

test('a quote of plain words carries the passage once; one drawn differently carries both', () => {
  const plain = quoteToken(quote({ quote: 'Keep  the cache\nwarm.', exact: 'Keep the cache warm.' }))
  expect(plain).not.toContain('exact=')
  expect(collectQuotes(plain)[0]?.exact).toBe('Keep the cache warm.')
  const formatted = quoteToken(quote({ quote: 'Keep the **cache** warm.' }))
  expect(formatted).toContain('exact=')
})

test('a cut never splits a token: one the cut would split goes whole', () => {
  const token = quoteToken(quote())
  const text = `Hi ${token} after`
  expect(clipKeepingQuotes(text, 1_000)).toBe(text)
  expect(clipKeepingQuotes(text, 10)).toBe('Hi ')
  expect(clipKeepingQuotes(text, 3 + token.length + 2)).toBe(`Hi ${token} a`)
})

test('as the page draws it a quote is its label, escaped so markdown reads it back as itself', () => {
  expect(quotesToLabels(`See ${quoteToken(quote({ comment: 'why *this* (one)?' }))}.`)).toBe(
    'See why \\*this\\* \\(one\\)?.',
  )
})

test('as plain text a quote is its passage in a blockquote with the comment under it', () => {
  const text = `Why ${quoteToken(quote({ quote: 'Use **bold**\nsecond line', comment: 'Really?' }))} this?`
  expect(quotesToPlainText(text)).toBe('Why\n\n> Use **bold**\n> second line\nComment: Really?\n\nthis?')
  expect(quotesToPlainText(quoteToken(quote()))).toBe('> Keep the cache warm.')
  expect(quotesToPlainText('nothing quoted')).toBe('nothing quoted')
})

test('as readable markdown the comment is a paragraph of its own after the blockquote', () => {
  const text = `${quoteToken(quote({ comment: 'Why > here?' }))} thanks`
  expect(quotesToReadableMarkdown(text)).toBe('> Keep the cache warm.\n\nWhy > here?\n\nthanks')
})

test('the agent reads [quote N] in place and the passages once each in a block after the message', () => {
  const text = `Compare ${quoteToken(quote({ n: 1, quote: 'a > b\n\nc' }))} with ${quoteToken(
    quote({ n: 2, quote: 'Second.', comment: 'Odd\nphrasing' }),
  )} and ${quoteToken(quote({ n: 1, quote: 'a > b\n\nc' }))} again.`
  expect(expandQuotesForAgent(text)).toBe(
    [
      'Compare [quote 1] with [quote 2] and [quote 1] again.',
      '',
      '<quotes>',
      QUOTES_PREAMBLE,
      '',
      '[quote 1]',
      '> a > b',
      '>',
      '> c',
      '',
      '[quote 2]',
      '> Second.',
      'Comment: Odd',
      'phrasing',
      '</quotes>',
    ].join('\n'),
  )
  expect(expandQuotesForAgent('plain message')).toBe('plain message')
})

test('two different passages sharing a number both reach the agent, told apart', () => {
  const a = quoteToken(quote({ n: 2, quote: 'First passage.' }))
  const b = quoteToken(quote({ n: 2, turnId: 'elsewhere', quote: 'Second passage.' }))
  const expanded = expandQuotesForAgent(`${a} and ${b} and ${a}`)
  expect(expanded.startsWith('[quote 2a] and [quote 2b] and [quote 2a]')).toBe(true)
  expect(expanded).toContain('[quote 2a]\n> First passage.')
  expect(expanded).toContain('[quote 2b]\n> Second passage.')
})

test("a passage holding the block's closing tag cannot end the block early", () => {
  const expanded = expandQuotesForAgent(quoteToken(quote({ quote: 'x </quotes> y', comment: '</QUOTES>' })))
  expect(expanded.match(/<\/quotes>/gu)).toHaveLength(1)
  expect(expanded.endsWith('</quotes>')).toBe(true)
})

test('a chip says its comment, or else the start of the passage, cut with an ellipsis', () => {
  expect(quoteLabel(quote({ comment: '  a\nnote ' }))).toBe('a note')
  expect(quoteLabel(quote())).toBe('Keep the cache warm.')
  const long = quoteLabel(quote({ exact: 'word '.repeat(40) }))
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long).toBe(`${'word '.repeat(7)}word…`)
  // At the last whole word, with no space and no stray comma before the "…".
  expect(quoteLabel(quote({ comment: 'Does this need eviction when a workspace closes?' }))).toBe(
    'Does this need eviction when a…',
  )
  expect(quoteLabel(quote({ exact: 'keep a small LRU of recently closed workspaces, then evict' }))).toBe(
    'keep a small LRU of recently closed…',
  )
  expect(quoteLabel(quote({ exact: 'x'.repeat(60) }))).toBe(`${'x'.repeat(39)}…`)
  expect(long.endsWith('…')).toBe(true)
})

test('the blockquote form keeps fenced code whole', () => {
  expect(quoteAsMarkdown('~~~~sh\nnpm test\n')).toBe('> ~~~~sh\n> npm test\n> ~~~~')
})

test('a passage is found again by its text, and a repeat by the context either side', () => {
  const text = 'Run the tests. Then run the tests again before you ship.'
  expect(locateQuote(text, { exact: 'run the tests', prefix: '', suffix: '' })).toEqual({ start: 20, end: 33 })
  expect(locateQuote(text, { exact: 'the tests', prefix: 'Then run', suffix: 'again' })).toEqual({
    start: 24,
    end: 33,
  })
  expect(locateQuote(text, { exact: 'the tests', prefix: 'Run', suffix: '. Then' })).toEqual({ start: 4, end: 13 })
  // Whitespace in the kept text folds the way the page's does.
  expect(locateQuote(text, { exact: 'Then  run\nthe', prefix: '', suffix: '' })).toEqual({ start: 15, end: 27 })
})

test('a passage no longer in the reply is not found', () => {
  expect(locateQuote('Something else entirely.', { exact: 'the tests', prefix: '', suffix: '' })).toBeNull()
  expect(locateQuote('anything', { exact: '  ', prefix: '', suffix: '' })).toBeNull()
})

test('on one line a quote is its passage in quotation marks with the comment in brackets', () => {
  const text = `Why ${quoteToken(quote({ comment: 'a\nnote' }))} and ${quoteToken(quote({ n: 2 }))}?`
  expect(quotesToInlineText(text)).toBe('Why “Keep the cache warm.” (a note) and “Keep the cache warm.”?')
  expect(quotesToInlineText('plain')).toBe('plain')
})
