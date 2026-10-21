// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { BrowserPointerEvent } from '../../../../../../shared/browser'
import { AgentBrowserCursor } from './AgentBrowserCursor'

let host: HTMLDivElement
let root: Root
let emit: (event: BrowserPointerEvent) => void = () => {}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, {
    api: {
      onBrowserPointer: (listener: (event: BrowserPointerEvent) => void) => {
        emit = listener
        return () => {}
      },
    },
  })
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root.render(<AgentBrowserCursor tabId="t1" scale={1} controller="agent" />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

test('the ring an agent click draws stops pulsing under Reduce Motion', () => {
  act(() => emit({ tabId: 't1', x: 40, y: 20, kind: 'click' }))
  const ring = host.querySelector('[data-agent-cursor="click"] span')
  expect(ring?.classList.contains('animate-ping')).toBe(true)
  expect(ring?.classList.contains('motion-reduce:animate-none')).toBe(true)
})
