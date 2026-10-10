import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { TabItem } from './Tabs'

// A reorderable strip (the workspace pane's): a press that travels is a drag
// that moves the tab where it is dropped, a press that does not is a click,
// Escape puts a dragged tab back, and Alt+Shift+Left/Right moves the focused
// tab from the keyboard.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previous = Object.getOwnPropertyDescriptors(globalThis)
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT']

// Each tab 100px wide from x = 0, so tab i's middle is at i * 100 + 50.
const TAB_WIDTH = 100

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const tabs = Array.from(this.parentElement?.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])
    const index = this.getAttribute('role') === 'tab' ? tabs.indexOf(this) : -1
    const left = index === -1 ? 0 : index * TAB_WIDTH
    const width = index === -1 ? tabs.length * TAB_WIDTH : TAB_WIDTH
    return { left, right: left + width, width, top: 0, bottom: 30, height: 30, x: left, y: 0, toJSON: () => ({}) }
  }
})

afterAll(() => {
  dom.window.close()
  for (const key of GLOBALS) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
})

const ITEMS: TabItem[] = [
  { id: 'files', label: 'Files' },
  { id: 'term', label: 'Terminal' },
  { id: 'page', label: 'Page' },
]

async function mountStrip() {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { Tabs } = await import('./Tabs')
  const moves: Array<[string, number]> = []
  const changes: string[] = []
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  function Strip() {
    const [items, setItems] = React.useState(ITEMS)
    return (
      <Tabs
        ariaLabel="Pane tabs"
        items={items}
        value="files"
        onChange={(id) => changes.push(id)}
        onReorder={(id, toIndex) => {
          moves.push([id, toIndex])
          setItems((current) => {
            const next = current.filter((item) => item.id !== id)
            next.splice(
              toIndex,
              0,
              current.find((item) => item.id === id)!,
            )
            return next
          })
        }}
      />
    )
  }
  await act(async () => root.render(<Strip />))
  const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[role="tab"][data-tab-id="${id}"]`)!
  const order = () => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).map((node) => node.dataset.tabId)
  const pointerEvent = (type: string, clientX: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }
  const pointer = async (target: EventTarget, type: string, clientX: number) => {
    await act(async () => {
      target.dispatchEvent(pointerEvent(type, clientX))
    })
  }
  return {
    act,
    host,
    tab,
    order,
    moves,
    changes,
    marker: () => host.querySelector('[data-tab-drop-marker]'),
    down: (id: string, x: number) => pointer(tab(id), 'pointerdown', x),
    move: (x: number) => pointer(dom.window, 'pointermove', x),
    up: (x: number) => pointer(dom.window, 'pointerup', x),
    // A release on a tab: the browser fires the click in the same task as the
    // pointerup, before any timer runs.
    release: (id: string, x: number) =>
      act(async () => {
        tab(id).dispatchEvent(pointerEvent('pointerup', x))
        tab(id).click()
      }),
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

test('a press that does not travel past the threshold is a click, not a move', async () => {
  const strip = await mountStrip()
  await strip.down('term', 150)
  await strip.move(152)
  expect(strip.marker()).toBe(null)
  await strip.release('term', 152)
  expect(strip.moves).toEqual([])
  expect(strip.changes).toEqual(['term'])
  await strip.unmount()
})

test('a drag shows where the tab will land, moves it there on release, and eats the release click', async () => {
  const strip = await mountStrip()
  await strip.down('files', 50)
  await strip.move(280)
  const marker = strip.marker() as HTMLElement | null
  expect(marker).not.toBe(null)
  // The slot after the last tab (which ends at 300px) stands just inside the
  // strip, where the scroller's clip cannot take half of it.
  expect(marker?.style.left).toBe('299px')
  await strip.release('files', 280)
  expect(strip.moves).toEqual([['files', 2]])
  expect(strip.order()).toEqual(['term', 'page', 'files'])
  expect(strip.changes).toEqual([])
  expect(strip.marker()).toBe(null)
  await strip.unmount()
})

test('a drag back over its own place shows nothing and moves nothing', async () => {
  const strip = await mountStrip()
  await strip.down('term', 150)
  await strip.move(120)
  expect(strip.marker()).toBe(null)
  await strip.up(120)
  expect(strip.moves).toEqual([])
  await strip.unmount()
})

test('Escape mid-drag puts the tab back', async () => {
  const strip = await mountStrip()
  await strip.down('page', 250)
  await strip.move(10)
  expect(strip.marker()).not.toBe(null)
  await strip.act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(strip.marker()).toBe(null)
  await strip.up(10)
  expect(strip.moves).toEqual([])
  expect(strip.order()).toEqual(['files', 'term', 'page'])
  await strip.unmount()
})

test('Alt+Shift+Right and Left move the focused tab one place, without wrapping, and keep it focused', async () => {
  const strip = await mountStrip()
  const key = async (id: string, keyName: string) => {
    strip.tab(id).focus()
    await strip.act(async () => {
      strip
        .tab(id)
        .dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: keyName, altKey: true, shiftKey: true, bubbles: true }),
        )
    })
  }
  await key('files', 'ArrowRight')
  expect(strip.order()).toEqual(['term', 'files', 'page'])
  expect(dom.window.document.activeElement).toBe(strip.tab('files'))
  await key('files', 'ArrowLeft')
  await key('files', 'ArrowLeft')
  expect(strip.order()).toEqual(['files', 'term', 'page'])
  expect(strip.moves).toEqual([
    ['files', 1],
    ['files', 0],
  ])
  // Moving is not switching.
  expect(strip.changes).toEqual([])
  await strip.unmount()
})

test('in a narrow scroller, a drag toward a cut-off slot scrolls it clear of the edge fade', async () => {
  const strip = await mountStrip()
  // The scroller shows 250px of the 300px strip: the last tab is cut off.
  const scrolls: number[] = []
  Object.defineProperty(strip.host, 'scrollWidth', { value: 300 })
  Object.defineProperty(strip.host, 'clientWidth', { value: 250 })
  strip.host.getBoundingClientRect = () =>
    ({ left: 0, right: 250, width: 250, top: 0, bottom: 30, height: 30, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  strip.host.scrollBy = ((options: ScrollToOptions) => scrolls.push(options.left ?? 0)) as typeof strip.host.scrollBy
  await strip.down('files', 50)
  await strip.move(280)
  // The end of the strip (300) is brought in past the 28px fade (250 - 28).
  expect(scrolls).toEqual([78])
  expect((strip.marker() as HTMLElement | null)?.style.left).toBe('299px')
  await strip.up(280)
  await strip.unmount()
})
