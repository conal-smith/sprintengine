import { expect, test } from 'vitest'
import { isNearConversationEnd, settleDisclosureResize } from './useStickToBottom'

test('follow-end threshold keeps scrollback independent from incoming output', () => {
  expect(isNearConversationEnd(0, 300, 600)).toBe(true)
  expect(isNearConversationEnd(700, 1000, 300)).toBe(true)
  expect(isNearConversationEnd(653, 1000, 300)).toBe(true)
  expect(isNearConversationEnd(652, 1000, 300)).toBe(false)
  expect(isNearConversationEnd(0, 1000, 300)).toBe(false)
})

// A transcript 1000 tall in a 300 viewport, read at its end (scrollTop 700),
// whose disclosure row sits at `top` on screen.
function transcript(top: number, scrollTop = 700) {
  const row = { top }
  const scroller = { scrollTop, scrollHeight: 1000, clientHeight: 300 }
  return { row: { getBoundingClientRect: () => ({ top: row.top }) as DOMRect }, rowAt: row, scroller }
}

test('opening the last row at the end stops following, the row staying under the pointer', () => {
  const { row, scroller } = transcript(600)
  // The row's top holds; its output grows the transcript below the fold.
  scroller.scrollHeight = 1400
  expect(settleDisclosureResize(row, 600, scroller, true)).toBe(false)
  expect(scroller.scrollTop).toBe(700)
})

test('a row that opens within the end slack keeps following', () => {
  const { row, scroller } = transcript(600)
  scroller.scrollHeight = 1020
  expect(settleDisclosureResize(row, 600, scroller, true)).toBe(true)
})

test('collapsing a row at the end keeps following', () => {
  const { row, scroller } = transcript(600)
  // The list has not measured the shrink yet, so the scroller is as it was.
  expect(settleDisclosureResize(row, 600, scroller, true)).toBe(true)
})

test('a toggle in scrollback puts the row back and leaves the reader there', () => {
  const { row, rowAt, scroller } = transcript(100, 200)
  // A row above re-measured and pushed the toggled one down by 40.
  rowAt.top = 140
  scroller.scrollHeight = 1400
  expect(settleDisclosureResize(row, 100, scroller, false)).toBe(false)
  expect(scroller.scrollTop).toBe(240)
})

test('a toggle in scrollback does not start following, even one that ends at the end', () => {
  const { row, scroller } = transcript(600)
  expect(settleDisclosureResize(row, 600, scroller, false)).toBe(false)
})
