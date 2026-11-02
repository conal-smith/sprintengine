import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import { citationForRange, quoteSources, rangeForQuote } from './quoteAnchors'

// A reply drawn the way the transcript draws one: its prose carries the turn
// it belongs to, and chrome inside it (a code block's header) is not text.
function page(html: string) {
  const { document } = new JSDOM(`<!doctype html><body>${html}</body>`).window
  const textAt = (needle: string, nth = 0): [Text, number] => {
    const walker = document.createTreeWalker(document.body, 4)
    let seen = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let from = 0
      for (let index = node.textContent!.indexOf(needle); index >= 0; index = node.textContent!.indexOf(needle, from)) {
        if (seen++ === nth) return [node as Text, index]
        from = index + 1
      }
    }
    throw new Error(`no text “${needle}”`)
  }
  const between = (from: string, to: string, toNth = 0) => {
    const [startNode, startOffset] = textAt(from)
    const [endNode, endOffset] = textAt(to, toNth)
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset + to.length)
    return range
  }
  return { document, between }
}

const REPLY =
  '<div data-quote-source="t1"><p>Run the tests first.</p><p>Then <strong>run the tests</strong> again before you ship.</p>' +
  '<div data-copy-exclude="">Copy</div></div>'

test('a selection in one reply cites its turn, the words as drawn and the words either side', () => {
  const { between } = page(REPLY)
  expect(citationForRange(between('run the tests', 'tests', 1))).toEqual({
    turnId: 't1',
    exact: 'run the tests',
    prefix: 'Run the tests first. Then',
    suffix: 'again before you ship.',
  })
})

test('a selection outside a reply, or across two of them, cites nothing', () => {
  const { between } = page(`${REPLY}<div data-quote-source="t2"><p>Other reply.</p></div><p>Outside words.</p>`)
  expect(citationForRange(between('Outside', 'words'))).toBeNull()
  expect(citationForRange(between('again', 'Other'))).toBeNull()
})

test('a cited passage is found again, a repeat told apart by the words either side', () => {
  const { document } = page(REPLY)
  const elements = quoteSources(document.body).get('t1')!
  const second = rangeForQuote(elements, { exact: 'run the tests', prefix: 'first. Then', suffix: 'again' })
  expect(second?.toString()).toBe('run the tests')
  expect(second?.startContainer.parentElement?.tagName).toBe('STRONG')
  const first = rangeForQuote(elements, { exact: 'Run the tests', prefix: '', suffix: 'first.' })
  expect(first?.startContainer.parentElement?.tagName).toBe('P')
  // Across a paragraph break, which the page draws as a space.
  expect(rangeForQuote(elements, { exact: 'first. Then', prefix: '', suffix: '' })?.toString()).toBe('first.Then')
})

test('a passage that is not in the reply any more is not found', () => {
  const { document } = page(REPLY)
  const elements = quoteSources(document.body).get('t1')!
  expect(rangeForQuote(elements, { exact: 'deploy on Friday', prefix: '', suffix: '' })).toBeNull()
  expect(rangeForQuote([], { exact: 'Run', prefix: '', suffix: '' })).toBeNull()
  expect(quoteSources(document.body).get('missing')).toBeUndefined()
})
