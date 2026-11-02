// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'

import { chatFindQuery, findInChat } from './chatFind'
import {
  CHAT_FIND_CURRENT_HIGHLIGHT,
  CHAT_FIND_HIGHLIGHT,
  clearChatFind,
  paintChatFind,
  renderedSegments,
  segmentRanges,
} from './chatFindHighlight'
import type { ConversationTimelineRow } from './conversationTimeline'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { quoteToken } from '../../../../../shared/chat-quotes'
import { UserTimelineRow } from './timelineRows'

afterEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { CSS?: unknown }).CSS
  delete (globalThis as { Highlight?: unknown }).Highlight
})

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

test('a match is found across the inline elements the page split it into', () => {
  const root = mount('<div data-chat-find-segment="reply:t1"><p>The <strong>config</strong> file</p></div>')
  const ranges = segmentRanges(renderedSegments(root).get('reply:t1')!, chatFindQuery('the CONFIG file'))
  expect(ranges.map(String)).toEqual(['The config file'])
})

test('block edges and line breaks read as spaces, as the index reads newlines', () => {
  const root = mount(
    '<div data-chat-find-segment="user:u1"><p>first line<br>second</p><ul><li>one</li><li>two</li></ul></div>',
  )
  const elements = renderedSegments(root).get('user:u1')!
  // The range spans the <br>, which has no text of its own to print.
  expect(segmentRanges(elements, chatFindQuery('line second')).map(String)).toEqual(['linesecond'])
  expect(segmentRanges(elements, chatFindQuery('one two'))).toHaveLength(1)
  expect(segmentRanges(elements, chatFindQuery('linesecond'))).toHaveLength(0)
})

test("a segment's chrome is not its text", () => {
  const root = mount(
    '<div data-chat-find-segment="reply:t1"><section><div data-copy-exclude="">ts Copy code</div><pre>const ts = 1</pre></section></div>',
  )
  const ranges = segmentRanges(renderedSegments(root).get('reply:t1')!, chatFindQuery('ts'))
  expect(ranges.map(String)).toEqual(['ts'])
  expect(ranges[0]!.startContainer.parentElement?.tagName).toBe('PRE')
})

test('a segment drawn in two places is searched as one, in document order', () => {
  const root = mount(
    '<span data-chat-find-segment="plan:r1">Ship it</span><button>Copy plan</button><div data-chat-find-segment="plan:r1"><p>Build, then ship.</p></div>',
  )
  const segments = renderedSegments(root)
  expect([...segments.keys()]).toEqual(['plan:r1'])
  expect(segmentRanges(segments.get('plan:r1')!, chatFindQuery('ship')).map(String)).toEqual(['Ship', 'ship'])
})

test('the page and the index count the same matches in ordinary markdown', () => {
  const text = 'Use **find** to _find_ things.\n\n- find one\n- `find` two'
  const row: ConversationTimelineRow = {
    kind: 'user',
    id: 'user:u1',
    entry: { kind: 'user', id: 'u1', text } as Extract<ConversationTimelineRow, { kind: 'user' }>['entry'],
  }
  const root = mount(
    '<div data-chat-find-segment="user:u1"><p>Use <strong>find</strong> to <em>find</em> things.</p><ul><li>find one</li><li><code>find</code> two</li></ul></div>',
  )
  const folded = chatFindQuery('Find')
  expect(segmentRanges(renderedSegments(root).get('user:u1')!, folded)).toHaveLength(
    findInChat([row], folded).matches.length,
  )
})

test('a quote is counted as its chip draws it, so the page can paint every match the index counts', () => {
  const token = quoteToken({
    turnId: 't1',
    n: 1,
    quote: 'Keep the cache warm before the deploy.',
    exact: 'Keep the cache warm before the deploy.',
    prefix: '',
    suffix: '',
    comment: 'Why (warm) cache?',
  })
  const text = `About the cache: ${token}`
  const row: ConversationTimelineRow = {
    kind: 'user',
    id: 'user:u1',
    entry: { kind: 'user', id: 'u1', text } as Extract<ConversationTimelineRow, { kind: 'user' }>['entry'],
  }
  const root = mount(
    renderToStaticMarkup(createElement(UserTimelineRow, { entry: { kind: 'user', id: 'u1', seq: 1, text } })),
  )
  const elements = renderedSegments(root).get('user:u1')!
  for (const query of ['cache', 'why (warm)', 'deploy', 'sprintengine']) {
    const folded = chatFindQuery(query)
    expect(segmentRanges(elements, folded), query).toHaveLength(findInChat([row], folded).matches.length)
  }
  expect(findInChat([row], chatFindQuery('cache')).matches).toHaveLength(2)
})

test('highlights are painted where the API exists, and nothing breaks where it does not', () => {
  const root = mount('<p data-chat-find-segment="user:u1">alpha beta alpha</p>')
  const ranges = segmentRanges(renderedSegments(root).get('user:u1')!, 'alpha')
  const owner = {}
  // jsdom has no CSS Custom Highlight API: painting is a no-op, not a throw.
  paintChatFind(owner, ranges, ranges[1]!)
  clearChatFind(owner)

  const registry = new Map<string, { ranges: Range[]; priority: number }>()
  ;(globalThis as { CSS?: unknown }).CSS = {
    highlights: {
      set: (name: string, value: { ranges: Range[]; priority: number }) => registry.set(name, value),
      delete: (name: string) => registry.delete(name),
    },
  }
  ;(globalThis as { Highlight?: unknown }).Highlight = class {
    ranges: Range[]
    priority = 0
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }
  const other = {}
  paintChatFind(owner, ranges, ranges[1]!)
  paintChatFind(other, ranges.slice(0, 1), null)
  // Two chats' finds share the document's one registry.
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges).toHaveLength(3)
  expect(registry.get(CHAT_FIND_CURRENT_HIGHLIGHT)?.ranges).toEqual([ranges[1]])
  expect(registry.get(CHAT_FIND_CURRENT_HIGHLIGHT)?.priority).toBe(1)
  clearChatFind(owner)
  expect(registry.get(CHAT_FIND_HIGHLIGHT)?.ranges).toHaveLength(1)
  expect(registry.has(CHAT_FIND_CURRENT_HIGHLIGHT)).toBe(false)
  clearChatFind(other)
  expect(registry.size).toBe(0)
})
