import { JSDOM } from 'jsdom'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import type { LegendListRef } from '@legendapp/list/react'
import { TRANSCRIPT_FOOT, TRANSCRIPT_SCROLL_PADDING_CLASS, TranscriptHead } from './transcriptEnds'
import { isNearConversationEnd } from './useStickToBottom'

// The real virtual list, set up as the chat view sets it up, over a jsdom that
// lays nothing out: each row says how tall it renders, the transcript's two
// ends render at the gap (`pt-4` and `pb-4`, 16px), and the scroller is as tall
// as the chat column leaves it once the tray and the composer under it have
// their share. The resize observer is fired by hand, as the browser fires it
// when the tray grows and the scroller shrinks.
const GAP = 16
const ROW = 100
const ROWS = 12
const CONTENT = GAP + ROWS * ROW + GAP

let viewport = 400
const observed = new Map<Element, (entries: unknown[]) => void>()
let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

function heightOf(element: Element): number {
  if (element.hasAttribute('data-scroller')) return viewport
  if (element.hasAttribute('data-transcript-head') || element.hasAttribute('data-transcript-foot')) return GAP
  if (element.hasAttribute('data-row')) return ROW
  // A wrapper the list puts around one of those, or around all of them.
  let sum = 0
  for (const child of Array.from(element.children)) sum += heightOf(child)
  return sum
}

// Long enough for the list's first landing at the end to finish.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 200)))

async function mountTranscript() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = globalThis as Record<string, unknown>
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, globals[key]]))
  class FakeResizeObserver {
    constructor(private readonly callback: (entries: unknown[]) => void) {}
    observe(target: Element) {
      observed.set(target, this.callback)
    }
    unobserve(target: Element) {
      observed.delete(target)
    }
    disconnect() {}
  }
  const scrollTops = new WeakMap<Element, number>()
  const proto = dom.window.HTMLElement.prototype
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const height = heightOf(this)
    return { top: 0, left: 0, right: 600, bottom: height, width: 600, height, x: 0, y: 0, toJSON() {} } as DOMRect
  }
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this)
    },
  })
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 600 })
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-scroller') ? Math.max(viewport, CONTENT) : heightOf(this)
    },
  })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight)
      scrollTops.set(this, Math.min(max, Math.max(0, value)))
      this.dispatchEvent(new dom.window.Event('scroll'))
    },
  })
  proto.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top
  } as HTMLElement['scrollTo']
  proto.scrollBy = function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop += options.top
  } as HTMLElement['scrollBy']
  Object.assign(dom.window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { LegendList } = await import('@legendapp/list/react')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root: Root = createRoot(host)
  const list = createRef<LegendListRef>()
  const scroller = () => list.current!.getScrollableNode() as HTMLElement
  const data = Array.from({ length: ROWS }, (_, index) => ({ id: `row-${index}` }))
  // Following the end while the reader is near it, as the chat view does.
  let following = true
  const render = () =>
    root.render(
      <LegendList
        ref={list}
        data={data}
        keyExtractor={(row) => row.id}
        renderItem={() => <div data-row="" />}
        estimatedItemSize={ROW}
        recycleItems
        // The chat view's scroller: no padding of its own above or below.
        className={`h-full overflow-y-auto ${TRANSCRIPT_SCROLL_PADDING_CLASS}`}
        data-scroller=""
        ListHeaderComponent={<TranscriptHead />}
        ListFooterComponent={TRANSCRIPT_FOOT}
        initialScrollAtEnd
        maintainVisibleContentPosition={{ data: true, size: true }}
        maintainScrollAtEnd={
          following ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } } : false
        }
        onScroll={() => {
          const element = scroller()
          const near = isNearConversationEnd(element.scrollTop, element.scrollHeight, element.clientHeight)
          if (near === following) return
          following = near
          render()
        }}
      />,
    )
  await act(async () => render())
  await settle()
  cleanup = async () => {
    await act(async () => root.unmount())
    dom.window.close()
    observed.clear()
    viewport = 400
    for (const key of keys) globals[key] = previous[key]
  }
  return {
    scroller,
    following: () => following,
    async scrollTo(offset: number) {
      await act(async () => {
        scroller().scrollTop = offset
      })
      await settle()
    },
    /** The tray or the composer under the transcript is now `by` taller. */
    async dockGrows(by: number) {
      viewport -= by
      await act(async () => {
        for (const [target, callback] of observed)
          callback([
            {
              target,
              borderBoxSize: [{ blockSize: heightOf(target), inlineSize: 600 }],
              contentRect: { top: 0, left: 0, width: 600, height: heightOf(target) },
            },
          ])
      })
      await settle()
    },
    /** How far the last row's bottom sits above the scroller's bottom edge, where the dock begins. */
    gapBelowLastRow: () => scroller().scrollTop + viewport - (CONTENT - GAP),
  }
}

test('at the end, the last row sits one gap above where the dock begins, and the end is the real end', async () => {
  const chat = await mountTranscript()
  expect(chat.scroller().scrollTop).toBe(chat.scroller().scrollHeight - viewport)
  expect(chat.gapBelowLastRow()).toBe(GAP)
})

test('the dock growing while the reader is at the end keeps the last row clear of it', async () => {
  const chat = await mountTranscript()
  // A background command starts, then a message is queued under it.
  await chat.dockGrows(36)
  expect(chat.following()).toBe(true)
  expect(chat.gapBelowLastRow()).toBe(GAP)
  await chat.dockGrows(44)
  expect(chat.following()).toBe(true)
  expect(chat.scroller().scrollTop).toBe(CONTENT - viewport)
  expect(chat.gapBelowLastRow()).toBe(GAP)
  // And the dock shrinking back: no jump that leaves the end above the fold.
  await chat.dockGrows(-80)
  expect(chat.gapBelowLastRow()).toBe(GAP)
})

test('the dock growing while the reader is up in the transcript leaves their place where it was', async () => {
  const chat = await mountTranscript()
  await chat.scrollTo(300)
  expect(chat.following()).toBe(false)
  await chat.dockGrows(80)
  expect(chat.scroller().scrollTop).toBe(300)
})

test('an empty dock adds no space of its own: below the last row is the gap, once', async () => {
  const chat = await mountTranscript()
  expect(chat.scroller().scrollHeight).toBe(CONTENT)
  expect(chat.gapBelowLastRow()).toBe(GAP)
})
