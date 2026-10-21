// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { Tabs, type TabItem } from './Tabs'

// A closable strip closes a tab on a middle-click. Chromium on Linux pastes the
// primary selection into the focused field on a middle release nobody
// cancelled, so closing a tab with the composer focused typed into it.

const items: TabItem<string>[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(onItemAuxClick?: (id: string) => void): HTMLButtonElement {
  act(() =>
    root.render(
      <Tabs
        ariaLabel="Pane"
        items={items}
        value="a"
        onChange={() => {}}
        onItemAuxClick={onItemAuxClick ? (id) => onItemAuxClick(id) : undefined}
      />,
    ),
  )
  return host.querySelector<HTMLButtonElement>('[data-tab-id="b"]')!
}

function mouse(target: Element, type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

test('a middle release on a tab of a strip that closes on middle-click is cancelled', () => {
  const closed: string[] = []
  const tab = render((id) => closed.push(id))
  expect(mouse(tab, 'mouseup', 1).defaultPrevented).toBe(true)
  mouse(tab, 'auxclick', 1)
  expect(closed).toEqual(['b'])
})

test('a left or right release on that strip is left alone', () => {
  const tab = render(() => {})
  expect(mouse(tab, 'mouseup', 0).defaultPrevented).toBe(false)
  expect(mouse(tab, 'mouseup', 2).defaultPrevented).toBe(false)
})

test('a strip that does nothing on middle-click leaves the middle release alone', () => {
  const tab = render()
  expect(mouse(tab, 'mouseup', 1).defaultPrevented).toBe(false)
})
