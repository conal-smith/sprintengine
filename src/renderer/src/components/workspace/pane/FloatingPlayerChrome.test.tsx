import assert from 'node:assert/strict'

// The miniature's overlay: nothing of the page's chrome — no title, no
// address, no page controls — and, under the pointer, the two things to do
// with it: open the page in the browser pane, or close the miniature.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest'

import type { WorkspacePaneTab } from '../../../types/workspace'

const calls: string[] = []
vi.mock('../../../store/workspaceStore', () => {
  const state = {
    updatePaneTab: () => calls.push('update'),
    setPaneTabFloating: (_ws: string, tabId: string, floating: boolean) => calls.push(`floating ${tabId} ${floating}`),
    dismissPaneTabFloat: (_ws: string, tabId: string) => calls.push(`dismiss ${tabId}`),
  }
  return { useWorkspaceStore: (selector: (s: typeof state) => unknown) => selector(state) }
})

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const TAB = {
  id: 'page',
  kind: 'browser',
  floating: true,
  title: 'Welcome to the example',
  url: 'https://example.com/',
} as WorkspacePaneTab

async function render(): Promise<HTMLElement> {
  const { FloatingPlayerChrome } = await import('./FloatingPlayer')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(
      React.createElement(FloatingPlayerChrome, {
        workspaceId: 'ws',
        tab: TAB,
        rect: { left: 10, top: 10, width: 320, height: 200 },
      }),
    )
  })
  return host
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name,
  )
  assert.ok(found, `a "${name}" button`)
  return found as HTMLButtonElement
}

test('the miniature draws none of the page chrome', async () => {
  const container = await render()
  const text = container.textContent ?? ''
  assert.ok(!text.includes(TAB.title as string), 'no page title')
  assert.ok(!text.includes('example.com'), 'no address')
  assert.equal(container.querySelectorAll('input').length, 0)
  assert.equal(container.querySelectorAll('[role="separator"]').length, 0, 'no resize grips')
  assert.deepEqual(
    [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()),
    ['Open', 'Close the floating browser'],
  )
})

test('Open docks the page in the pane, and Close puts the miniature away', async () => {
  const container = await render()
  act(() => button(container, 'Open').click())
  assert.deepEqual(calls, ['floating page false'])
  act(() => button(container, 'Close the floating browser').click())
  assert.deepEqual(calls, ['floating page false', 'dismiss page'])
})

test('the buttons show only under the pointer or keyboard focus', async () => {
  const container = await render()
  const reveal = button(container, 'Open').closest('.opacity-0')
  assert.ok(reveal, 'the controls rest hidden')
  assert.match(reveal.className, /group-hover:opacity-100/)
  assert.match(reveal.className, /group-focus-within:opacity-100/)
})
